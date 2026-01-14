import { prisma } from '../db';
import { logger } from '../utils/logger';
import { computeGroupMetrics } from './groupMetrics';
import { computeUserMetrics } from './userMetrics';

export interface StrategyRecommendation {
  strategyType: 'user' | 'group';
  targetId: number;
  targetName: string;
  window: '7D' | '30D' | 'ALL';
  expectedReturn: number;
  winRate: number;
  riskScore: number;
  consistencyScore: number;
  recommendation: 'STRONG_BUY' | 'BUY' | 'NEUTRAL' | 'AVOID';
  reasoning: string;
}

const calculateRecommendation = (
  winRate: number,
  expectedReturn: number,
  consistencyScore: number,
  riskScore: number
): { recommendation: 'STRONG_BUY' | 'BUY' | 'NEUTRAL' | 'AVOID'; reasoning: string } => {
  // Scoring algorithm
  const score = (winRate * 0.4) + (Math.min(expectedReturn / 5, 1) * 0.3) + (consistencyScore * 0.2) - (riskScore * 0.1);

  if (score >= 0.75 && winRate >= 0.6 && expectedReturn >= 2.0) {
    return {
      recommendation: 'STRONG_BUY',
      reasoning: `Excellent track record: ${(winRate * 100).toFixed(1)}% win rate, ${expectedReturn.toFixed(2)}x average return, high consistency.`,
    };
  } else if (score >= 0.6 && winRate >= 0.5 && expectedReturn >= 1.5) {
    return {
      recommendation: 'BUY',
      reasoning: `Good performance: ${(winRate * 100).toFixed(1)}% win rate, ${expectedReturn.toFixed(2)}x average return.`,
    };
  } else if (score >= 0.4 && winRate >= 0.4) {
    return {
      recommendation: 'NEUTRAL',
      reasoning: `Moderate performance: ${(winRate * 100).toFixed(1)}% win rate. Proceed with caution.`,
    };
  } else {
    return {
      recommendation: 'AVOID',
      reasoning: `Poor performance: ${(winRate * 100).toFixed(1)}% win rate. High risk, low returns.`,
    };
  }
};

export const computeGroupStrategy = async (
  groupId: number,
  window: '7D' | '30D' | 'ALL' = '30D'
): Promise<StrategyRecommendation | null> => {
  try {
    const group = await prisma.group.findUnique({
      where: { id: groupId },
    });

    if (!group) {
      return null;
    }

    const metrics = await computeGroupMetrics(groupId, window);

    if (metrics.signalCount === 0) {
      return null;
    }

    // Expected return = median ATH (simplified)
    const expectedReturn = metrics.medianAth;
    const winRate = metrics.hit2Rate;
    const consistencyScore = 0.7; // Placeholder - could compute from variance
    const riskScore = Math.abs(metrics.medianDrawdown);

    const { recommendation, reasoning } = calculateRecommendation(
      winRate,
      expectedReturn,
      consistencyScore,
      riskScore
    );

    return {
      strategyType: 'group',
      targetId: groupId,
      targetName: group.name || group.chatId.toString(),
      window,
      expectedReturn,
      winRate,
      riskScore,
      consistencyScore,
      recommendation,
      reasoning,
    };
  } catch (error) {
    logger.error(`Error computing group strategy for ${groupId}:`, error);
    return null;
  }
};

export const computeUserStrategy = async (
  userId: number,
  window: '7D' | '30D' | 'ALL' = '30D'
): Promise<StrategyRecommendation | null> => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      return null;
    }

    const metrics = await computeUserMetrics(userId, window);

    if (metrics.signalCount === 0) {
      return null;
    }

    const expectedReturn = metrics.medianAth;
    const winRate = metrics.hit2Rate;
    const consistencyScore = metrics.consistencyScore || 0.5;
    const riskScore = metrics.riskScore || 0.5;

    const { recommendation, reasoning } = calculateRecommendation(
      winRate,
      expectedReturn,
      consistencyScore,
      riskScore
    );

    const userName = user.username || user.firstName || user.userId.toString();

    return {
      strategyType: 'user',
      targetId: userId,
      targetName: userName,
      window,
      expectedReturn,
      winRate,
      riskScore,
      consistencyScore,
      recommendation,
      reasoning,
    };
  } catch (error) {
    logger.error(`Error computing user strategy for ${userId}:`, error);
    return null;
  }
};

export const getTopStrategies = async (
  limit: number = 10,
  window: '7D' | '30D' | 'ALL' = '30D'
): Promise<StrategyRecommendation[]> => {
  try {
    const strategies: StrategyRecommendation[] = [];

    // Get top groups
    const groupMetrics = await prisma.groupMetric.findMany({
      where: { window },
      include: { group: true },
      orderBy: { hit2Rate: 'desc' },
      take: limit,
    });

    for (const metric of groupMetrics) {
      const strategy = await computeGroupStrategy(metric.groupId, window);
      if (strategy) {
        strategies.push(strategy);
      }
    }

    // Get top users
    const userMetrics = await prisma.userMetric.findMany({
      where: { window },
      include: { user: true },
      orderBy: { hit2Rate: 'desc' },
      take: limit,
    });

    for (const metric of userMetrics) {
      const strategy = await computeUserStrategy(metric.userId, window);
      if (strategy) {
        strategies.push(strategy);
      }
    }

    // Sort by recommendation score
    strategies.sort((a, b) => {
      const scoreA = (a.winRate * 0.4) + (Math.min(a.expectedReturn / 5, 1) * 0.3) + (a.consistencyScore * 0.2) - (a.riskScore * 0.1);
      const scoreB = (b.winRate * 0.4) + (Math.min(b.expectedReturn / 5, 1) * 0.3) + (b.consistencyScore * 0.2) - (b.riskScore * 0.1);
      return scoreB - scoreA;
    });

    return strategies.slice(0, limit);
  } catch (error) {
    logger.error('Error getting top strategies:', error);
    return [];
  }
};

export const simulateCopyTrading = async (
  strategyType: 'user' | 'group',
  targetId: number,
  window: '7D' | '30D' | 'ALL' = '30D',
  initialCapital: number = 1000
): Promise<{
  initialCapital: number;
  finalValue: number;
  totalReturn: number;
  returnPercent: number;
  signalsFollowed: number;
  wins: number;
  losses: number;
}> => {
  try {
    const days = window === '7D' ? 7 : window === '30D' ? 30 : 36500;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    const signals = await prisma.signal.findMany({
      where: {
        ...(strategyType === 'user' ? { userId: targetId } : { groupId: targetId }),
        detectedAt: { gte: cutoff },
        entryPrice: { not: null },
      },
      include: {
        metrics: true,
      },
      orderBy: { detectedAt: 'asc' },
    });

    if (signals.length === 0) {
      return {
        initialCapital,
        finalValue: initialCapital,
        totalReturn: 0,
        returnPercent: 0,
        signalsFollowed: 0,
        wins: 0,
        losses: 0,
      };
    }

    // Simulate: invest equal amount in each signal
    const perSignalInvestment = initialCapital / signals.length;
    let finalValue = 0;
    let wins = 0;
    let losses = 0;

    for (const signal of signals) {
      if (!signal.entryPrice || !signal.metrics) {
        continue;
      }

      const currentMultiple = signal.metrics.currentMultiple;
      const signalReturn = perSignalInvestment * currentMultiple;
      finalValue += signalReturn;

      if (currentMultiple >= 2) {
        wins++;
      } else if (currentMultiple < 1) {
        losses++;
      }
    }

    const totalReturn = finalValue - initialCapital;
    const returnPercent = (totalReturn / initialCapital) * 100;

    return {
      initialCapital,
      finalValue,
      totalReturn,
      returnPercent,
      signalsFollowed: signals.length,
      wins,
      losses,
    };
  } catch (error) {
    logger.error(`Error simulating copy trading for ${strategyType} ${targetId}:`, error);
    throw error;
  }
};











