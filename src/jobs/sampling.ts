import { prisma } from '../db';
import { provider } from '../providers';
import { addPriceSample, getLatestSample } from '../db/samples';
import { logger } from '../utils/logger';
import { differenceInMinutes, differenceInHours } from 'date-fns';
import { notifySignal } from '../bot/notifier'; // For alerts later
import { updateSignalMetrics } from '../analytics/metrics';
import { checkPriceAlerts } from './priceAlerts';

// Determine if signal is due for sampling
const isDueForSampling = (signal: any, lastSampleAt: Date | null): boolean => {
  const now = new Date();
  const ageMinutes = differenceInMinutes(now, signal.detectedAt);
  
  // If never sampled, it's due
  if (!lastSampleAt) return true;
  
  const minutesSinceSample = differenceInMinutes(now, lastSampleAt);
  
  // Schedule
  if (ageMinutes < 120) return minutesSinceSample >= 1; // 0-2h: 1m
  if (ageMinutes < 720) return minutesSinceSample >= 5; // 2-12h: 5m
  if (ageMinutes < 4320) return minutesSinceSample >= 15; // 12-72h (3d): 15m
  if (ageMinutes < 20160) return minutesSinceSample >= 60; // 3-14d: 60m
  if (ageMinutes < 86400) return minutesSinceSample >= 360; // 14-60d: 6h
  return minutesSinceSample >= 1440; // 60d+: 24h
};

export const runSamplingCycle = async () => {
  logger.info('Starting sampling cycle...');
  
  try {
    const signals = await prisma.signal.findMany({
      where: { trackingStatus: { in: ['ACTIVE', 'ENTRY_PENDING'] } },
      include: {
        priceSamples: {
          orderBy: { sampledAt: 'desc' },
          take: 1
        }
      }
    });

            const dueSignals = signals.filter((s: any) => {
      const lastSample = s.priceSamples[0]?.sampledAt || null;
      return isDueForSampling(s, lastSample);
    });

    if (dueSignals.length === 0) {
      logger.info('No signals due for sampling.');
      return;
    }

    logger.info(`Sampling ${dueSignals.length} signals...`);

    // Group by mint to batch (if provider supported batching, which we simulated individually for now)
    // We will run them in parallel with concurrency limit
    // For now, simple loop
    
    for (const signal of dueSignals) {
      try {
        const quote = await provider.getQuote(signal.mint);
        const meta = await provider.getTokenMeta(signal.mint);
        
        // Calculate market cap: prefer liveMarketCap, then marketCap, then calculate from price * supply
        let marketCap: number | null = null;
        if (meta.liveMarketCap) {
          marketCap = meta.liveMarketCap;
        } else if (meta.marketCap) {
          marketCap = meta.marketCap;
        } else if (quote.price && meta.supply) {
          marketCap = quote.price * meta.supply;
        }
        
        await addPriceSample(
          signal.id,
          signal.mint,
          quote.price,
          quote.source,
          marketCap,
          meta.volume24h || null,
          meta.liquidity || null
        );

        if (!signal.entryMarketCap && marketCap) {
          await prisma.signal.update({
            where: { id: signal.id },
            data: {
              entryMarketCap: marketCap,
              entryPrice: quote.price || signal.entryPrice,
              entryPriceAt: signal.entryPriceAt || new Date(),
              entryPriceProvider: quote.source || signal.entryPriceProvider,
              entrySupply: signal.entrySupply || meta.supply || null,
              trackingStatus: 'ACTIVE',
            },
          });
        }
        
        // Update Metrics & Check Thresholds (using market cap)
        await updateSignalMetrics(signal.id, marketCap || quote.price, quote.price);
        
      } catch (error) {
        logger.error(`Failed to sample ${signal.mint}:`, error);
      }
    }
    
    logger.info('Sampling cycle complete.');
    
    // Check price alerts after sampling
    await checkPriceAlerts();
  } catch (error) {
    logger.error('Error in sampling cycle:', error);
  }
};

