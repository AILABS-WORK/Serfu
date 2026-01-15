import { prisma } from '../db';
import { geckoTerminal } from '../providers/geckoTerminal';
import { bitquery } from '../providers/bitquery';
import { logger } from '../utils/logger';

/**
 * Periodically checks historical data for active signals to ensure
 * we captured the true ATH and Drawdown, even if the bot missed a tick.
 */
export const updateHistoricalMetrics = async (targetSignalIds?: number[]) => {
  try {
    logger.info(`Starting historical metrics update job... ${targetSignalIds ? `(Targeting ${targetSignalIds.length} signals)` : ''}`);
    
    // Get active signals
    // OPTIMIZATION: Only check signals created in the last 7 days for detailed "Recent Calls" accuracy
    // or sort by last updated to prioritize stale ones.
    const whereClause: any = {
      trackingStatus: 'ACTIVE',
      entryPrice: { not: null },
    };

    if (targetSignalIds && targetSignalIds.length > 0) {
        whereClause.id = { in: targetSignalIds };
    } else {
        whereClause.detectedAt = {
             gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) // Last 7 days
        };
    }

    const signals = await prisma.signal.findMany({
      where: whereClause,
      orderBy: { detectedAt: 'desc' }
    });

    logger.info(`Checking history for ${signals.length} active signals...`);

    // Process in batches of 5 to speed up if using Bitquery (concurrent requests)
    const BATCH_SIZE = 5;
    for (let i = 0; i < signals.length; i += BATCH_SIZE) {
        const batch = signals.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(async (signal) => {
            try {
                const entryPrice = signal.entryPrice || (signal.entryMarketCap && signal.entrySupply ? signal.entryMarketCap / signal.entrySupply : null);
                if (!entryPrice || !signal.detectedAt) return;

                const now = Date.now();
                const ageHours = (now - signal.detectedAt.getTime()) / (1000 * 60 * 60);
                
                let ohlcv: any[] = [];
                let source = 'gecko';

                // Priority 1: Bitquery (if API Key exists)
                if (process.env.BIT_QUERY_API_KEY) {
                    const timeframe = ageHours > 24 ? 'hour' : 'minute';
                    const limit = ageHours > 24 ? 1000 : 1440; 
                    try {
                        ohlcv = await (bitquery as any).getOHLCV(signal.mint, timeframe, limit);
                        if (ohlcv.length > 0) source = 'bitquery';
                    } catch (e) {
                        logger.error(`Bitquery failed for ${signal.mint}`, e);
                    }
                }

                // Priority 2: GeckoTerminal (Fallback)
                if (ohlcv.length === 0) {
                    let timeframe: 'minute' | 'hour' = ageHours > 16 ? 'hour' : 'minute';
                    ohlcv = await geckoTerminal.getOHLCV(signal.mint, timeframe, 1000);
                    
                    if (timeframe === 'minute' && ohlcv && ohlcv.length > 0) {
                        const oldestCandle = ohlcv[0];
                        const signalTime = signal.detectedAt.getTime();
                        if (oldestCandle.timestamp > signalTime + 300000) { 
                            timeframe = 'hour';
                            ohlcv = await geckoTerminal.getOHLCV(signal.mint, timeframe, 1000);
                        }
                    }
                    source = 'gecko';
                }
                
                if (!ohlcv || ohlcv.length === 0) return;

                const signalTime = signal.detectedAt.getTime();
                const validCandles = ohlcv.filter(c => c.timestamp >= signalTime - 300000); 

                if (validCandles.length === 0) return;

                let athPrice = entryPrice;
                let athAt = signal.detectedAt;
                let minPrice = entryPrice;
                let timeTo2x: number | null = null;
                let timeTo5x: number | null = null;
                let timeTo10x: number | null = null;

                for (const candle of validCandles) {
                    if (candle.high > athPrice) {
                        athPrice = candle.high;
                        athAt = new Date(candle.timestamp);
                    }
                    if (candle.low < minPrice) {
                        minPrice = candle.low;
                    }
                    if (!timeTo2x && candle.high >= entryPrice * 2) {
                        timeTo2x = candle.timestamp - signalTime;
                    }
                    if (!timeTo5x && candle.high >= entryPrice * 5) {
                        timeTo5x = candle.timestamp - signalTime;
                    }
                    if (!timeTo10x && candle.high >= entryPrice * 10) {
                        timeTo10x = candle.timestamp - signalTime;
                    }
                }

                // Force ATH >= Entry
                if (athPrice < entryPrice) athPrice = entryPrice;

                const athMultiple = athPrice / entryPrice;
                const maxDrawdown = (minPrice - entryPrice) / entryPrice;
                const currentPrice = validCandles[validCandles.length - 1].close;
                const currentMultiple = currentPrice / entryPrice;

                await prisma.signalMetric.upsert({
                    where: { signalId: signal.id },
                    create: {
                        signalId: signal.id,
                        currentPrice,
                        currentMultiple,
                        athPrice,
                        athMultiple,
                        athAt,
                        maxDrawdown,
                        timeTo2x,
                        timeTo5x,
                        timeTo10x,
                        updatedAt: new Date()
                    },
                    update: {
                        currentPrice,
                        currentMultiple,
                        athPrice,
                        athMultiple,
                        athAt,
                        maxDrawdown, 
                        timeTo2x: timeTo2x || undefined,
                        timeTo5x: timeTo5x || undefined,
                        timeTo10x: timeTo10x || undefined,
                        updatedAt: new Date()
                    }
                });
                
            } catch (err) {
                logger.error(`Error updating history for ${signal.mint}:`, err);
            }
        }));

        // Rate limit delay between batches
        await new Promise(r => setTimeout(r, 1000));
    }
    
    logger.info('Historical metrics update complete.');
  } catch (error) {
    logger.error('Error in updateHistoricalMetrics:', error);
  }
};


