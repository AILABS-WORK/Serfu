import { prisma } from '../db';
import { geckoTerminal } from '../providers/geckoTerminal';
import { logger } from '../utils/logger';

/**
 * Periodically checks historical data for active signals to ensure
 * we captured the true ATH and Drawdown, even if the bot missed a tick.
 */
export const updateHistoricalMetrics = async () => {
  try {
    logger.info('Starting historical metrics update job...');
    
    // Get active signals
    const signals = await prisma.signal.findMany({
      where: {
        trackingStatus: 'ACTIVE',
        entryPrice: { not: null },
      },
    });

    logger.info(`Checking history for ${signals.length} active signals...`);

    for (const signal of signals) {
      if (!signal.entryPrice || !signal.detectedAt) continue;

      try {
        // Fetch OHLCV since detection
        // Use minute candles for precision
        // Max 1000 minutes (~16 hours). If older, we might miss early peaks if we don't use 'hour'.
        // Let's use 'minute' if < 24h old, 'hour' if older.
        const now = Date.now();
        const ageHours = (now - signal.detectedAt.getTime()) / (1000 * 60 * 60);
        const timeframe = ageHours > 24 ? 'hour' : 'minute';

        const ohlcv = await geckoTerminal.getOHLCV(signal.mint, timeframe, 1000);
        
        if (!ohlcv || ohlcv.length === 0) continue;

        // Filter valid candles (after detection)
        const signalTime = signal.detectedAt.getTime();
        // Allow a small buffer (e.g. 5 mins before) in case clocks slightly off
        const validCandles = ohlcv.filter(c => c.timestamp >= signalTime - 300000);

        if (validCandles.length === 0) continue;

        let athPrice = signal.entryPrice;
        let athAt = signal.detectedAt;
        let minPrice = signal.entryPrice;

        // Get existing metrics to compare
        const existing = await prisma.signalMetric.findUnique({ where: { signalId: signal.id } });
        if (existing) {
          athPrice = existing.athPrice;
          minPrice = (1 + existing.maxDrawdown) * signal.entryPrice; // Convert % back to price approx
          // Actually better to track minPrice separately if we could, 
          // but reconstruction from maxDrawdown is okay-ish.
          // Let's just reset scan from entry price to be safe and true to history.
          athPrice = signal.entryPrice; 
          minPrice = signal.entryPrice;
        }

        for (const candle of validCandles) {
            if (candle.high > athPrice) {
                athPrice = candle.high;
                athAt = new Date(candle.timestamp);
            }
            if (candle.low < minPrice) {
                minPrice = candle.low;
            }
        }

        // Update if different
        const athMultiple = athPrice / signal.entryPrice;
        const maxDrawdown = (minPrice - signal.entryPrice) / signal.entryPrice;

        // Only update if we found better data or if it's missing
        if (!existing || athPrice > existing.athPrice || maxDrawdown < existing.maxDrawdown) {
             await prisma.signalMetric.upsert({
                where: { signalId: signal.id },
                create: {
                    signalId: signal.id,
                    currentPrice: validCandles[validCandles.length - 1].close,
                    currentMultiple: validCandles[validCandles.length - 1].close / signal.entryPrice,
                    athPrice,
                    athMultiple,
                    athAt,
                    maxDrawdown,
                    updatedAt: new Date()
                },
                update: {
                    athPrice,
                    athMultiple,
                    athAt,
                    maxDrawdown: maxDrawdown < (existing?.maxDrawdown ?? 0) ? maxDrawdown : undefined,
                    updatedAt: new Date()
                }
             });
             // logger.info(`Updated historical metrics for ${signal.mint}: ATH ${athMultiple.toFixed(2)}x`);
        }
        
        // Respect rate limits (GeckoTerminal is free but rate limited)
        await new Promise(r => setTimeout(r, 2000)); 

      } catch (err) {
        logger.error(`Error updating history for ${signal.mint}:`, err);
      }
    }
    
    logger.info('Historical metrics update complete.');
  } catch (error) {
    logger.error('Error in updateHistoricalMetrics:', error);
  }
};

