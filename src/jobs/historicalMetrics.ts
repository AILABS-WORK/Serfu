import { prisma } from '../db';
import { geckoTerminal } from '../providers/geckoTerminal';
import { logger } from '../utils/logger';
import { getEntryTime } from '../analytics/metricsUtils';

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
        const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        whereClause.OR = [
            { entryPriceAt: { gte: since } },
            { entryPriceAt: null, detectedAt: { gte: since } }
        ];
    }

    const signals = await prisma.signal.findMany({
      where: whereClause,
      orderBy: { detectedAt: 'desc' },
      include: {
        metrics: true,
        priceSamples: { orderBy: { sampledAt: 'desc' }, take: 1 }
      }
    });

    logger.info(`Checking history for ${signals.length} active signals...`);

    // Process in batches of 5 to speed up if using Bitquery (concurrent requests)
    const BATCH_SIZE = 5;
    for (let i = 0; i < signals.length; i += BATCH_SIZE) {
        const batch = signals.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(async (signal) => {
            try {
                const lastSample = signal.priceSamples?.[0];
                if (signal.metrics?.updatedAt) {
                    if (!lastSample || lastSample.sampledAt <= signal.metrics.updatedAt) return;
                    if ((lastSample.volume ?? 0) <= 0) return;
                }

                const entryPrice = signal.entryPrice || (signal.entryMarketCap && signal.entrySupply ? signal.entryMarketCap / signal.entrySupply : null);
                const entryTime = getEntryTime(signal);
                if (!entryPrice || !entryTime) return;

                const now = Date.now();
                const fetchStart = signal.metrics?.ohlcvLastAt ? signal.metrics.ohlcvLastAt.getTime() : entryTime.getTime();
                const ageHours = (now - fetchStart) / (1000 * 60 * 60);
                
                // OPTIMIZED: Use GeckoTerminal first (fastest, best success rate)
                // Benchmark showed GeckoTerminal minute parallel: 248.83ms/token with 3/6 success
                // Bitquery: 0% success rate
                let ohlcv: any[] = [];

                // Priority 1: GeckoTerminal (Fastest, best success rate)
                // Use progressive timeframe strategy: minute for recent, hour for older
                let timeframe: 'minute' | 'hour' | 'day' = ageHours <= 16 ? 'minute' : ageHours <= 720 ? 'hour' : 'day';
                const tfMs = timeframe === 'minute' ? 60 * 1000 : timeframe === 'hour' ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
                const limit = Math.min(1000, Math.max(10, Math.ceil((now - fetchStart) / tfMs) + 5));
                
                try {
                    ohlcv = await geckoTerminal.getOHLCV(signal.mint, timeframe, limit);
                    
                    // If minute candles don't cover entry period, try hour candles
                    if (timeframe === 'minute' && ohlcv.length > 0) {
                        const oldestCandle = ohlcv[0];
                        const signalTime = fetchStart;
                        // If oldest candle is > 5 minutes after signal, try hourly
                        if (oldestCandle.timestamp > signalTime + 300000) {
                            timeframe = 'hour';
                            ohlcv = await geckoTerminal.getOHLCV(signal.mint, timeframe, 1000);
                        }
                    }
                } catch (e) {
                    logger.debug(`GeckoTerminal failed for ${signal.mint}, trying Bitquery fallback:`, e);
                }

                if (!ohlcv || ohlcv.length === 0) return;
                const signalTime = fetchStart;
                const validCandles = ohlcv.filter(c => c.timestamp >= signalTime - 300000); 

                if (validCandles.length === 0) return;

                let athPrice = entryPrice;
                let athAt = signal.metrics?.athAt || entryTime;
                let minPrice = signal.metrics?.minLowPrice ?? entryPrice;
                let minAt = signal.metrics?.minLowAt ?? entryTime;
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
                        minAt = new Date(candle.timestamp);
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
                const maxDrawdown = ((minPrice - entryPrice) / entryPrice) * 100;
                const currentPrice = validCandles[validCandles.length - 1].close;
                const currentMultiple = currentPrice / entryPrice;
                const timeToAth = athAt.getTime() - entryTime.getTime();
                const timeToDrawdown = minAt.getTime() - entryTime.getTime();
                const timeFromDrawdownToAth = minAt.getTime() < athAt.getTime() ? athAt.getTime() - minAt.getTime() : null;
                const entrySupply = signal.entrySupply || (signal.entryMarketCap && entryPrice ? signal.entryMarketCap / entryPrice : null);
                const athMarketCap = entrySupply ? athPrice * entrySupply : (signal.entryMarketCap ? signal.entryMarketCap * athMultiple : null);
                const maxDrawdownMarketCap = entrySupply ? minPrice * entrySupply : (signal.entryMarketCap ? signal.entryMarketCap * (minPrice / entryPrice) : null);
                const currentMarketCap = entrySupply ? currentPrice * entrySupply : null;

                await prisma.signalMetric.upsert({
                    where: { signalId: signal.id },
                    create: {
                        signalId: signal.id,
                        currentPrice,
                        currentMultiple,
                        currentMarketCap: currentMarketCap || undefined,
                        athPrice,
                        athMultiple,
                        athMarketCap: athMarketCap || undefined,
                        athAt,
                        timeToAth,
                        maxDrawdown,
                        maxDrawdownMarketCap: maxDrawdownMarketCap || undefined,
                        timeFromDrawdownToAth,
                        timeTo2x,
                        timeTo5x,
                        timeTo10x,
                        ohlcvLastAt: validCandles.length > 0 ? new Date(validCandles[validCandles.length - 1].timestamp) : undefined,
                        minLowPrice: minPrice,
                        minLowAt: minAt,
                        updatedAt: new Date()
                    },
                    update: {
                        currentPrice,
                        currentMultiple,
                        currentMarketCap: currentMarketCap || undefined,
                        athPrice,
                        athMultiple,
                        athMarketCap: athMarketCap || undefined,
                        athAt,
                        timeToAth,
                        maxDrawdown,
                        maxDrawdownMarketCap: maxDrawdownMarketCap || undefined,
                        timeFromDrawdownToAth,
                        timeToDrawdown,
                        ohlcvLastAt: validCandles.length > 0 ? new Date(validCandles[validCandles.length - 1].timestamp) : undefined,
                        minLowPrice: minPrice,
                        minLowAt: minAt,
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

/**
 * Full backfill for ALL signals with entry data.
 * Runs in batches to avoid rate limits and timeouts.
 */
export const runHistoricalMetricsBackfill = async (batchSize = 200) => {
  try {
    logger.info(`[HistoricalMetrics] Starting full backfill (batchSize=${batchSize})...`);
    let lastId = 0;
    let totalProcessed = 0;

    while (true) {
      const batch = await prisma.signal.findMany({
        where: {
          id: { gt: lastId },
          entryPrice: { not: null }
        },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: batchSize
      });

      if (batch.length === 0) break;
      const ids = batch.map(b => b.id);
      lastId = ids[ids.length - 1];
      totalProcessed += ids.length;

      logger.info(`[HistoricalMetrics] Backfill batch ${ids[0]}..${lastId} (${ids.length} signals)`);
      await updateHistoricalMetrics(ids);

      // Throttle between batches
      await new Promise(r => setTimeout(r, 1500));
    }

    logger.info(`[HistoricalMetrics] Full backfill complete. Processed ${totalProcessed} signals.`);
  } catch (error) {
    logger.error('Error in runHistoricalMetricsBackfill:', error);
  }
};


