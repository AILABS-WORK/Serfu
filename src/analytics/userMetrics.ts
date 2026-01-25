import { prisma } from '../db';
import { logger } from '../utils/logger';
import { getEntryTime } from './metricsUtils';

export const computeUserMetrics = async (userId: number, window: '7D' | '30D' | 'ALL') => {
  try {
    const days = window === '7D' ? 7 : window === '30D' ? 30 : 36500;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    const signals = await prisma.signal.findMany({
      where: {
        userId,
        OR: [
          { entryPriceAt: { gte: cutoff } },
          { entryPriceAt: null, detectedAt: { gte: cutoff } }
        ]
      },
      include: {
        metrics: true,
        thresholdEvents: true,
      },
    });

    const count = signals.length;
    if (count === 0) {
      return {
        signalCount: 0,
        hit2Rate: 0,
        hit3Rate: 0,
        hit5Rate: 0,
        hit10Rate: 0,
        medianAth: 0,
        p75Ath: 0,
        p90Ath: 0,
        medianDrawdown: 0,
        medianTimeTo2x: null,
        avgWinRate: 0,
        totalSignals: 0,
        consistencyScore: null,
        riskScore: null,
      };
    }

    // Hit rates
    const hit2 = signals.filter((s: any) => s.thresholdEvents.some((e: any) => e.multipleThreshold >= 2)).length;
    const hit3 = signals.filter((s: any) => s.thresholdEvents.some((e: any) => e.multipleThreshold >= 3)).length;
    const hit5 = signals.filter((s: any) => s.thresholdEvents.some((e: any) => e.multipleThreshold >= 5)).length;
    const hit10 = signals.filter((s: any) => s.thresholdEvents.some((e: any) => e.multipleThreshold >= 10)).length;

    // ATH multiples
    const aths = signals
      .map((s: any) => s.metrics?.athMultiple || 1.0)
      .filter((a: number) => a > 0)
      .sort((a: number, b: number) => a - b);
    
    const medianAth = aths.length > 0 ? aths[Math.floor(aths.length / 2)] : 0;
    const p75Ath = aths.length > 0 ? aths[Math.floor(aths.length * 0.75)] : 0;
    const p90Ath = aths.length > 0 ? aths[Math.floor(aths.length * 0.9)] : 0;

    // Drawdowns
    const dds = signals
      .map((s: any) => s.metrics?.maxDrawdown || 0)
      .sort((a: number, b: number) => a - b);
    const medianDd = dds.length > 0 ? dds[Math.floor(dds.length / 2)] : 0;

    // Time to 2x
    const timesTo2x = signals
      .map((s: any) => {
        const event = s.thresholdEvents.find((e: any) => e.multipleThreshold === 2);
        const entryTime = getEntryTime(s);
        if (!event || !entryTime) return null;
        return (event.hitAt.getTime() - entryTime.getTime()) / 1000; // seconds
      })
      .filter((t: number | null): t is number => t !== null)
      .sort((a: number, b: number) => a - b);
    
    const medianTimeTo2x = timesTo2x.length > 0 
      ? timesTo2x[Math.floor(timesTo2x.length / 2)] 
      : null;

    // Win rate
    const avgWinRate = hit2 / count;

    // Consistency Score (0-1): Based on how consistent the win rate is
    // Simple implementation: variance of ATH multiples (lower variance = higher consistency)
    const athVariance = aths.length > 1
      ? aths.reduce((sum: number, val: number) => sum + Math.pow(val - medianAth, 2), 0) / aths.length
      : 0;
    const consistencyScore = Math.max(0, Math.min(1, 1 - (athVariance / (medianAth || 1))));

    // Risk Score (0-1): Based on drawdowns (higher drawdown = higher risk)
    const avgDrawdown = dds.length > 0 
      ? dds.reduce((sum: number, dd: number) => sum + Math.abs(dd), 0) / dds.length 
      : 0;
    const riskScore = Math.max(0, Math.min(1, Math.abs(avgDrawdown) / 100));

    return {
      signalCount: count,
      hit2Rate: hit2 / count,
      hit3Rate: hit3 / count,
      hit5Rate: hit5 / count,
      hit10Rate: hit10 / count,
      medianAth,
      p75Ath,
      p90Ath,
      medianDrawdown: medianDd,
      medianTimeTo2x,
      avgWinRate,
      totalSignals: count,
      consistencyScore,
      riskScore,
    };
  } catch (error) {
    logger.error(`Error computing user metrics for user ${userId}:`, error);
    throw error;
  }
};

export const updateUserMetrics = async (userId: number) => {
  const windows: Array<'7D' | '30D' | 'ALL'> = ['7D', '30D', 'ALL'];

  for (const window of windows) {
    try {
      const metrics = await computeUserMetrics(userId, window);

      await prisma.userMetric.upsert({
        where: {
          userId_window: {
            userId,
            window,
          },
        },
        create: {
          userId,
          window,
          ...metrics,
        },
        update: {
          ...metrics,
          updatedAt: new Date(),
        },
      });
    } catch (error) {
      logger.error(`Error updating user metrics for user ${userId}, window ${window}:`, error);
    }
  }
};

export const updateAllUserMetrics = async () => {
  const users = await prisma.user.findMany();

  logger.info(`Updating metrics for ${users.length} users...`);

  for (const user of users) {
    await updateUserMetrics(user.id);
  }

  logger.info('User metrics update complete.');
};

