import { prisma } from '../db';
import { logger } from '../utils/logger';
import { updateAllGroupMetrics } from '../analytics/groupMetrics';
import { updateAllUserMetrics } from '../analytics/userMetrics';

export const runAggregationCycle = async () => {
  logger.info('Starting aggregation cycle...');
  
  // Windows: 7D, 30D, ALL
  const windows = [
    { name: '7D', days: 7 },
    { name: '30D', days: 30 },
    { name: 'ALL', days: 36500 } // 100 years
  ];

  for (const window of windows) {
    try {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - window.days);

      // Get all categories (currently just 'General')
      const categories = await prisma.signal.groupBy({
        by: ['category'],
        where: {
          OR: [
            { entryPriceAt: { gte: cutoff } },
            { entryPriceAt: null, detectedAt: { gte: cutoff } }
          ]
        }
      });

      for (const cat of categories) {
        const category = cat.category || 'Uncategorized';
        
        // Fetch stats
        const signals = await prisma.signal.findMany({
          where: {
            category,
            OR: [
              { entryPriceAt: { gte: cutoff } },
              { entryPriceAt: null, detectedAt: { gte: cutoff } }
            ]
          },
          include: {
            metrics: true,
            thresholdEvents: true
          }
        });

        const count = signals.length;
        if (count === 0) continue;

        const hit2 = signals.filter((s: any) => s.thresholdEvents.some((e: any) => e.multipleThreshold >= 2)).length;
        const hit3 = signals.filter((s: any) => s.thresholdEvents.some((e: any) => e.multipleThreshold >= 3)).length;
        const hit5 = signals.filter((s: any) => s.thresholdEvents.some((e: any) => e.multipleThreshold >= 5)).length;

        // Median ATH
        const aths = signals.map((s: any) => s.metrics?.athMultiple || 1.0).sort((a: number, b: number) => a - b);
        const medianAth = aths[Math.floor(aths.length / 2)] || 1.0;
        const p75Ath = aths[Math.floor(aths.length * 0.75)] || 1.0;
        
        // Median Drawdown
        const dds = signals.map((s: any) => s.metrics?.maxDrawdown || 0).sort((a: number, b: number) => a - b);
        const medianDd = dds[Math.floor(dds.length / 2)] || 0;

        // Save
        await prisma.categoryMetric.upsert({
          where: {
            category_window: {
              category,
              window: window.name
            }
          },
          create: {
            category,
            window: window.name,
            signalCount: count,
            hit2Rate: hit2 / count,
            hit3Rate: hit3 / count,
            hit5Rate: hit5 / count,
            medianAth,
            p75Ath,
            medianDrawdown: medianDd
          },
          update: {
             signalCount: count,
             hit2Rate: hit2 / count,
             hit3Rate: hit3 / count,
             hit5Rate: hit5 / count,
             medianAth,
             p75Ath,
             medianDrawdown: medianDd,
             updatedAt: new Date()
          }
        });
      }

    } catch (err) {
          logger.error(`Aggregation failed for window ${window.name}`, err);
        }
      }

      // Update Group Metrics
      try {
        await updateAllGroupMetrics();
      } catch (err) {
        logger.error('Group metrics update failed:', err);
      }

      // Update User Metrics
      try {
        await updateAllUserMetrics();
      } catch (err) {
        logger.error('User metrics update failed:', err);
      }

      logger.info('Aggregation cycle complete.');
    };

