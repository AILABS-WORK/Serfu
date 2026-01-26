import { prisma } from '../db';
import { geckoTerminal } from '../providers/geckoTerminal';
import { getMultipleTokenPrices } from '../providers/jupiter';
import { logger } from '../utils/logger';
import { getEntryTime, hasComputedAth, hasComputedDrawdown, hasComputedTimes } from '../analytics/metricsUtils';

export type HistoricalMetricsBackfillProgress = {
  status: 'idle' | 'running' | 'complete' | 'error';
  totalSignals: number;
  totalMints: number;
  processedSignals: number;
  batchSize: number;
  startedAt: Date | null;
  updatedAt: Date | null;
  endedAt: Date | null;
  lastBatchCount: number;
  lastSignalId: number | null;
  errorMessage: string | null;
};

const backfillProgress: HistoricalMetricsBackfillProgress = {
  status: 'idle',
  totalSignals: 0,
  totalMints: 0,
  processedSignals: 0,
  batchSize: 0,
  startedAt: null,
  updatedAt: null,
  endedAt: null,
  lastBatchCount: 0,
  lastSignalId: null,
  errorMessage: null
};

const updateBackfillProgress = (patch: Partial<HistoricalMetricsBackfillProgress>) => {
  Object.assign(backfillProgress, patch);
  if (backfillProgress.status === 'running') {
    backfillProgress.updatedAt = new Date();
  }
};

export const getHistoricalMetricsBackfillProgress = (): HistoricalMetricsBackfillProgress => ({
  ...backfillProgress
});

/**
 * Periodically checks historical data for active signals to ensure
 * we captured the true ATH and Drawdown, even if the bot missed a tick.
 */
export const updateHistoricalMetrics = async (targetSignalIds?: number[]) => {
  try {
    logger.info(`Starting historical metrics update job... ${targetSignalIds ? `(Targeting ${targetSignalIds.length} signals)` : ''}`);
    const shouldTrackProgress = backfillProgress.status === 'running' && !!targetSignalIds?.length;
    const markProcessed = (signalId?: number) => {
      if (!shouldTrackProgress) return;
      updateBackfillProgress({
        processedSignals: backfillProgress.processedSignals + 1,
        lastSignalId: signalId ?? backfillProgress.lastSignalId
      });
    };
    const ohlcvCache = new Map<string, any[]>();
    
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

    const RECENT_METRICS_MS = 6 * 60 * 60 * 1000;
    const VERY_RECENT_MS = 30 * 60 * 1000;
    const PRICE_ATH_BUFFER = 1.02; // 2% above ATH triggers recalculation

    const uniqueMints = Array.from(new Set(signals.map(s => s.mint)));
    let priceMap: Record<string, number | null> = {};
    if (uniqueMints.length > 0) {
      try {
        priceMap = await getMultipleTokenPrices(uniqueMints);
      } catch (err) {
        logger.warn('[HistoricalMetrics] Failed to fetch current prices for backfill gating:', err);
        priceMap = {};
      }
    }

    const signalsToProcess: typeof signals = [];
    let skippedFresh = 0;
    let skippedComplete = 0;
    for (const signal of signals) {
      const metrics = signal.metrics;
      if (!metrics) {
        signalsToProcess.push(signal);
        continue;
      }

      const metricsAge = Date.now() - metrics.updatedAt.getTime();
      const incomplete = !hasComputedAth(metrics) || !hasComputedDrawdown(metrics) || !hasComputedTimes(metrics);
      if (incomplete) {
        signalsToProcess.push(signal);
        continue;
                }

      const currentPrice = priceMap[signal.mint];
      if (currentPrice && metrics.athPrice > 0 && currentPrice > metrics.athPrice * PRICE_ATH_BUFFER) {
        signalsToProcess.push(signal);
        continue;
      }

      if (metricsAge < VERY_RECENT_MS) {
        skippedFresh++;
        markProcessed(signal.id);
        continue;
      }

      if (metricsAge < RECENT_METRICS_MS && currentPrice !== undefined) {
        skippedComplete++;
        markProcessed(signal.id);
        continue;
      }

      if (metricsAge < 24 * 60 * 60 * 1000 && (currentPrice === null || currentPrice === undefined)) {
        skippedComplete++;
        markProcessed(signal.id);
        continue;
      }

      signalsToProcess.push(signal);
    }

    if (skippedFresh > 0 || skippedComplete > 0) {
      logger.info(`[HistoricalMetrics] Skipping ${skippedFresh} fresh + ${skippedComplete} complete signals (using current price check).`);
    }

    // Process in batches of unique mints (avoid duplicate OHLCV fetches)
    const signalsByMint = new Map<string, typeof signals>();
    for (const signal of signalsToProcess) {
      const list = signalsByMint.get(signal.mint) || [];
      list.push(signal);
      signalsByMint.set(signal.mint, list);
    }
    const uniqueMintsToProcess = Array.from(signalsByMint.keys());
    const MINT_BATCH_SIZE = Number(process.env.GECKO_OHLCV_PARALLEL ?? 3);
    for (let i = 0; i < uniqueMintsToProcess.length; i += MINT_BATCH_SIZE) {
        const mintBatch = uniqueMintsToProcess.slice(i, i + MINT_BATCH_SIZE);
        await Promise.all(mintBatch.map(async (mint) => {
            const mintSignals = signalsByMint.get(mint) || [];
            let sharedOhlcv: any[] = [];
            let sharedTimeframe: 'minute' | 'hour' | 'day' = 'hour';
            let sharedLimit = 0;
            let sharedFetchStart = 0;

            try {
                const now = Date.now();
                const fetchStarts = mintSignals
                  .map(s => {
                    const entryTime = getEntryTime(s);
                    if (!entryTime) return null;
                    return s.metrics?.ohlcvLastAt ? s.metrics.ohlcvLastAt.getTime() : entryTime.getTime();
                  })
                  .filter((t): t is number => !!t);

                if (fetchStarts.length === 0) {
                  mintSignals.forEach(s => markProcessed(s.id));
                  return;
                }

                sharedFetchStart = Math.min(...fetchStarts);
                const ageMs = now - sharedFetchStart;
                const minuteMs = 60 * 1000;
                const hourMs = 60 * 60 * 1000;
                const dayMs = 24 * 60 * 60 * 1000;
                const minuteLimit = Math.ceil(ageMs / minuteMs) + 5;
                const hourLimit = Math.ceil(ageMs / hourMs) + 5;

                if (minuteLimit <= 1000) sharedTimeframe = 'minute';
                else if (hourLimit <= 1000) sharedTimeframe = 'hour';
                else sharedTimeframe = 'day';

                const tfMs = sharedTimeframe === 'minute' ? minuteMs : sharedTimeframe === 'hour' ? hourMs : dayMs;
                sharedLimit = Math.min(1000, Math.max(10, Math.ceil(ageMs / tfMs) + 5));
                const cacheKey = `${mint}:${sharedTimeframe}:${sharedLimit}:${sharedFetchStart}`;

                const cached = ohlcvCache.get(cacheKey);
                if (cached) {
                  sharedOhlcv = cached;
                } else {
                  sharedOhlcv = await geckoTerminal.getOHLCV(mint, sharedTimeframe, sharedLimit);
                  ohlcvCache.set(cacheKey, sharedOhlcv);
                }

                if (sharedTimeframe === 'minute' && sharedOhlcv.length > 0) {
                    const oldestCandle = sharedOhlcv[0];
                    if (oldestCandle.timestamp > sharedFetchStart + 300000) {
                        sharedTimeframe = 'hour';
                        const fallbackKey = `${mint}:${sharedTimeframe}:1000:${sharedFetchStart}`;
                        const cachedFallback = ohlcvCache.get(fallbackKey);
                        if (cachedFallback) {
                          sharedOhlcv = cachedFallback;
                        } else {
                          sharedOhlcv = await geckoTerminal.getOHLCV(mint, sharedTimeframe, 1000);
                          ohlcvCache.set(fallbackKey, sharedOhlcv);
                        }
                        }
                    }
                } catch (e) {
                logger.debug(`GeckoTerminal failed for ${mint}, trying Bitquery fallback:`, e);
                }

            if (!sharedOhlcv || sharedOhlcv.length === 0) {
              mintSignals.forEach(s => markProcessed(s.id));
              return;
            }

            await Promise.all(mintSignals.map(async (signal) => {
                try {
                    const lastSample = signal.priceSamples?.[0];
                    if (signal.metrics?.updatedAt) {
                        if (!lastSample || lastSample.sampledAt <= signal.metrics.updatedAt) {
                          markProcessed(signal.id);
                          return;
                        }
                        if ((lastSample.volume ?? 0) <= 0) {
                          markProcessed(signal.id);
                          return;
                        }
                    }

                    const entryPrice = signal.entryPrice || (signal.entryMarketCap && signal.entrySupply ? signal.entryMarketCap / signal.entrySupply : null);
                    const entryTime = getEntryTime(signal);
                    if (!entryPrice || !entryTime) {
                      markProcessed(signal.id);
                      return;
                    }

                    const fetchStart = signal.metrics?.ohlcvLastAt ? signal.metrics.ohlcvLastAt.getTime() : entryTime.getTime();
                    const validCandles = sharedOhlcv.filter(c => c.timestamp >= fetchStart - 300000); 

                    if (validCandles.length === 0) {
                      markProcessed(signal.id);
                      return;
                    }

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
                            timeTo2x = candle.timestamp - fetchStart;
                    }
                    if (!timeTo5x && candle.high >= entryPrice * 5) {
                            timeTo5x = candle.timestamp - fetchStart;
                    }
                    if (!timeTo10x && candle.high >= entryPrice * 10) {
                            timeTo10x = candle.timestamp - fetchStart;
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
                    markProcessed(signal.id);
            } catch (err) {
                logger.error(`Error updating history for ${signal.mint}:`, err);
                    markProcessed(signal.id);
            }
            }));
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
    if (backfillProgress.status === 'running') {
      logger.warn('[HistoricalMetrics] Backfill already running, skipping new request.');
      return;
    }

    logger.info(`[HistoricalMetrics] Starting full backfill (batchSize=${batchSize})...`);
    const startedAt = new Date();
    const totalSignals = await prisma.signal.count({
      where: { entryPrice: { not: null } }
    });
    const totalMints = await prisma.signal.findMany({
      where: { entryPrice: { not: null } },
      distinct: ['mint'],
      select: { mint: true }
    });
    updateBackfillProgress({
      status: 'running',
      totalSignals,
      totalMints: totalMints.length,
      processedSignals: 0,
      batchSize,
      startedAt,
      updatedAt: startedAt,
      endedAt: null,
      lastBatchCount: 0,
      lastSignalId: null,
      errorMessage: null
    });

    if (totalSignals === 0) {
      updateBackfillProgress({
        status: 'complete',
        processedSignals: 0,
        endedAt: new Date()
      });
      logger.info('[HistoricalMetrics] Full backfill complete. No signals found.');
      return;
    }

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
      updateBackfillProgress({
        processedSignals: totalProcessed,
        lastBatchCount: ids.length,
        lastSignalId: lastId
      });

      // Throttle between batches
      await new Promise(r => setTimeout(r, 1500));
    }

    logger.info(`[HistoricalMetrics] Full backfill complete. Processed ${totalProcessed} signals.`);
    updateBackfillProgress({
      status: 'complete',
      processedSignals: totalProcessed,
      endedAt: new Date()
    });
  } catch (error) {
    logger.error('Error in runHistoricalMetricsBackfill:', error);
    updateBackfillProgress({
      status: 'error',
      endedAt: new Date(),
      errorMessage: error instanceof Error ? error.message : String(error)
    });
  }
};


