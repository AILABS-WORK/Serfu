import { prisma } from '../db';
import { logger } from '../utils/logger';
import { geckoTerminal } from '../providers/geckoTerminal';
import { Signal, SignalMetric, PriceSample } from '../generated/client';

export type SignalWithRelations = Signal & {
  metrics: SignalMetric | null;
  priceSamples: PriceSample[];
};

/**
 * Enriches a signal with current price data from Jupiter.
 * Updates the in-memory signal object.
 * @param signals List of signals to enrich
 */
export const enrichSignalsWithCurrentPrice = async (signals: SignalWithRelations[]) => {
  if (signals.length === 0) return;

  const uniqueMints = Array.from(new Set(signals.map(s => s.mint)));
  
  // Use Jupiter batch API to fetch prices for all mints at once (up to 50 per batch)
  // We'll process in chunks of 50 to be safe
  const BATCH_SIZE = 50;
  const priceMap: Record<string, number | null> = {};

  try {
    const { getMultipleTokenPrices } = await import('../providers/jupiter');
    
    for (let i = 0; i < uniqueMints.length; i += BATCH_SIZE) {
        const batch = uniqueMints.slice(i, i + BATCH_SIZE);
        const batchPrices = await getMultipleTokenPrices(batch);
        Object.assign(priceMap, batchPrices);
    }

    // Update in-memory signals
    for (const sig of signals) {
        const currentPrice = priceMap[sig.mint];
        if (currentPrice !== null && currentPrice !== undefined) {
            // Ensure metrics object exists
            if (!sig.metrics) {
                sig.metrics = {
                    signalId: sig.id,
                    currentPrice: 0,
                    currentMultiple: 0,
                    athPrice: 0,
                    athMultiple: 0,
                    athMarketCap: 0,
                    athAt: sig.detectedAt,
                    maxDrawdown: 0,
                    timeToAth: 0,
                    timeTo2x: null,
                    timeTo3x: null,
                    timeTo5x: null,
                    timeTo10x: null,
                    stagnationTime: null,
                    drawdownDuration: null,
                    updatedAt: new Date(),
                    currentMarketCap: 0 // Adding missing property
                } as any;
            }

            const metrics = sig.metrics!;
            metrics.currentPrice = currentPrice;

            // Calculate current multiple
            // 1. Try entryPrice directly
            // 2. Try deriving from entryMarketCap and entrySupply
            let entryPrice = sig.entryPrice;
            if (!entryPrice && sig.entryMarketCap && sig.entrySupply) {
                entryPrice = sig.entryMarketCap / sig.entrySupply;
            }
            // 3. Try price samples
            if (!entryPrice && sig.priceSamples?.[0]?.price) {
                entryPrice = sig.priceSamples[0].price;
            }

            if (entryPrice && entryPrice > 0) {
                metrics.currentMultiple = currentPrice / entryPrice;
            } else {
                metrics.currentMultiple = 1.0;
            }

            // Calculate current Market Cap
            if (sig.entrySupply) {
                metrics.currentMarketCap = currentPrice * sig.entrySupply;
            } else if (metrics.currentMultiple && sig.entryMarketCap) {
                metrics.currentMarketCap = sig.entryMarketCap * metrics.currentMultiple;
            }
        }
    }
  } catch (err) {
    logger.error('Error in enrichSignalsWithCurrentPrice:', err);
  }
};

/**
 * Enriches a single signal with ATH metrics using boundary-based OHLCV windows.
 * Fetches candle data from GeckoTerminal and updates the DB.
 * @param sig Signal to enrich
 * @param force Force recalculation even if metrics are fresh
 */
export const enrichSignalMetrics = async (
    sig: SignalWithRelations,
    force: boolean = false,
    currentPriceOverride?: number
): Promise<void> => {
    const STALE_METRICS_MS = 5 * 60 * 1000; // 5 minutes
    const now = Date.now();

    // Check if we need to calculate
    if (!force && sig.metrics?.updatedAt) {
        const age = now - sig.metrics.updatedAt.getTime();
        if (age < STALE_METRICS_MS) return; // Metrics are fresh enough
    }

    try {
        // Skip OHLCV if we have no activity since last update (volume check)
        if (!force && sig.metrics?.updatedAt) {
            const latestSample = await prisma.priceSample.findFirst({
                where: {
                    signalId: sig.id,
                    sampledAt: { gt: sig.metrics.updatedAt }
                },
                orderBy: { sampledAt: 'desc' }
            });
            if (!latestSample || (latestSample.volume ?? 0) <= 0) {
                return;
            }
        }
        const entryTimestamp = sig.detectedAt.getTime();
        
        // Determine Entry Data (Price & Supply)
        let entryPrice = sig.entryPrice;
        let entrySupply = sig.entrySupply;
        let entryMc = sig.entryMarketCap || 0;

        // Fallback to price samples if entry data missing on signal
        if ((!entryPrice || !entrySupply) && sig.priceSamples?.length > 0) {
            const firstSample = sig.priceSamples[0];
            if (!entryPrice) entryPrice = firstSample.price;
            if (!entryMc) entryMc = firstSample.marketCap || 0;
            if (!entrySupply && entryPrice && entryMc) entrySupply = entryMc / entryPrice;
        }

        if (!entrySupply || entrySupply <= 0 || !entryPrice || entryPrice <= 0) {
            // Last ditch: derive price if we have MC and Supply, or Supply if we have MC and Price
            if (entryMc > 0 && entrySupply! > 0) entryPrice = entryMc / entrySupply!;
            else return; // Can't calculate ATH without baseline
        }

        // TypeScript guard
        if (!entryPrice) return; 

        const entryPriceValue = entryPrice; // Valid number now

        const nowTimestamp = Date.now();
        let maxHigh = 0;
        let maxAt = entryTimestamp;

        const currentPrice = currentPriceOverride ?? sig.metrics?.currentPrice ?? 0;

        // Boundary-based OHLCV strategy:
        // - Minute candles from entry to next hour boundary
        // - Hourly candles from hour boundary to next day boundary
        // - Daily candles from day boundary to now
        const entryDate = new Date(entryTimestamp);
        const hourBoundary = new Date(entryDate);
        hourBoundary.setMinutes(0, 0, 0);
        hourBoundary.setHours(hourBoundary.getHours() + 1);
        const hourBoundaryTs = hourBoundary.getTime();

        const dayBoundary = new Date(entryDate);
        dayBoundary.setHours(0, 0, 0, 0);
        dayBoundary.setDate(dayBoundary.getDate() + 1);
        const dayBoundaryTs = dayBoundary.getTime();

        let candlesFound = 0;
        const allCandles: Array<{ timestamp: number; high: number; low: number }> = [];

        // Minute candles: entry -> hour boundary
        if (nowTimestamp > entryTimestamp) {
            const minuteEnd = Math.min(hourBoundaryTs, nowTimestamp);
            if (minuteEnd > entryTimestamp) {
                const minutesNeeded = Math.ceil((minuteEnd - entryTimestamp) / (60 * 1000)) + 2;
                const minuteLimit = Math.min(1000, minutesNeeded);
                try {
                    const minuteCandles = await geckoTerminal.getOHLCV(sig.mint, 'minute', minuteLimit);
                    const postEntryMinutes = minuteCandles.filter(
                        (c) => c.timestamp >= entryTimestamp && c.timestamp < minuteEnd
                    );
                    candlesFound += postEntryMinutes.length;
                    for (const candle of postEntryMinutes) {
                        allCandles.push({ timestamp: candle.timestamp, high: candle.high, low: candle.low });
                        if (candle.high > maxHigh) {
                            maxHigh = candle.high;
                            maxAt = candle.timestamp;
                        }
                    }
                } catch (err) {
                    logger.debug(`GeckoTerminal minute candles failed for ${sig.mint}: ${err}`);
                }
            }
        }

        // Hourly candles: hour boundary -> day boundary
        if (nowTimestamp > hourBoundaryTs) {
            const hourEnd = Math.min(dayBoundaryTs, nowTimestamp);
            if (hourEnd > hourBoundaryTs) {
                const hoursNeeded = Math.ceil((hourEnd - hourBoundaryTs) / (60 * 60 * 1000)) + 2;
                const hourLimit = Math.min(1000, hoursNeeded);
                try {
                    const hourlyCandles = await geckoTerminal.getOHLCV(sig.mint, 'hour', hourLimit);
                    const hourlyInRange = hourlyCandles.filter(
                        (c) => c.timestamp >= hourBoundaryTs && c.timestamp < hourEnd
                    );
                    candlesFound += hourlyInRange.length;
                    for (const candle of hourlyInRange) {
                        allCandles.push({ timestamp: candle.timestamp, high: candle.high, low: candle.low });
                        if (candle.high > maxHigh) {
                            maxHigh = candle.high;
                            maxAt = candle.timestamp;
                        }
                    }
                } catch (err) {
                    logger.debug(`GeckoTerminal hourly candles failed for ${sig.mint}: ${err}`);
                }
            }
        }

        // Daily candles: day boundary -> now
        if (nowTimestamp > dayBoundaryTs) {
            const daysNeeded = Math.ceil((nowTimestamp - dayBoundaryTs) / (24 * 60 * 60 * 1000)) + 2;
            const dayLimit = Math.min(1000, daysNeeded);
            try {
                const dailyCandles = await geckoTerminal.getOHLCV(sig.mint, 'day', dayLimit);
                const dailyInRange = dailyCandles.filter((c) => c.timestamp >= dayBoundaryTs);
                candlesFound += dailyInRange.length;
                for (const candle of dailyInRange) {
                    allCandles.push({ timestamp: candle.timestamp, high: candle.high, low: candle.low });
                    if (candle.high > maxHigh) {
                        maxHigh = candle.high;
                        maxAt = candle.timestamp;
                    }
                }
            } catch (err) {
                logger.debug(`GeckoTerminal daily candles failed for ${sig.mint}: ${err}`);
            }
        }

        if (candlesFound === 0) {
            if (!sig.metrics?.athPrice || sig.metrics.athPrice <= 0) {
                return;
            }
            maxHigh = sig.metrics.athPrice;
            maxAt = sig.metrics.athAt?.getTime?.() || entryTimestamp;
        } else {
            // Ensure ATH is never below entry price when OHLCV exists
            if (maxHigh < entryPriceValue) {
                maxHigh = entryPriceValue;
                maxAt = entryTimestamp;
            }
        }

        // Ensure ATH is never below Current Price
        if (currentPrice > 0 && maxHigh < currentPrice) {
            maxHigh = currentPrice;
            maxAt = nowTimestamp; // If current is ATH, ATH time is now
        }

        // Never allow ATH to decrease below cached ATH price if it exists
        if (sig.metrics?.athPrice && sig.metrics.athPrice > maxHigh) {
            maxHigh = sig.metrics.athPrice;
            maxAt = sig.metrics.athAt?.getTime?.() || maxAt;
        }

        // Calculate ATH multiple
        if (maxHigh > 0 && entryPriceValue > 0) {
            const athMultiple = maxHigh / entryPriceValue;

            // Update or create metrics for this signal
            const athMarketCap = entrySupply ? maxHigh * entrySupply : 0;
            const timeToAth = maxAt - entryTimestamp;

            // Calculate max drawdown: find lowest price between entry and ATH, compare to entry
            // Max drawdown = percentage decrease from entry price to lowest price in that period
            let maxDrawdown = 0;
            if (allCandles.length > 0) {
                // Filter candles to only those between entry and ATH time
                const candlesUpToAth = allCandles.filter(c => c.timestamp >= entryTimestamp && c.timestamp <= maxAt);
                
                // Find the lowest price (using candle.low) in the timeframe between entry and ATH
                let lowestPrice = entryPriceValue; // Start with entry price
                
                for (const candle of candlesUpToAth) {
                    // Use the low of the candle to find the absolute lowest price
                    if (candle.low < lowestPrice) {
                        lowestPrice = candle.low;
                    }
                }
                
                // Calculate max drawdown: percentage decrease from entry to lowest price
                if (entryPriceValue > 0) {
                    maxDrawdown = ((lowestPrice - entryPriceValue) / entryPriceValue) * 100;
                }
            } else {
                // If no OHLCV data, calculate simple drawdown from entry to current price
                // This gives us at least some drawdown metric even when GeckoTerminal fails
                if (currentPrice > 0 && entryPriceValue > 0) {
                    const simpleDrawdown = ((currentPrice - entryPriceValue) / entryPriceValue) * 100;
                    // If current is below entry, that's a drawdown
                    if (simpleDrawdown < 0) {
                        maxDrawdown = simpleDrawdown;
                    }
                }
            }

            if (sig.metrics) {
                // UPDATE
                await prisma.signalMetric.update({
                    where: { signalId: sig.id },
                    data: {
                        athMultiple,
                        athPrice: maxHigh,
                        athMarketCap,
                        athAt: new Date(maxAt),
                        timeToAth,
                        maxDrawdown,
                        updatedAt: new Date()
                    }
                });
                // Update in-memory
                sig.metrics.athMultiple = athMultiple;
                sig.metrics.athPrice = maxHigh;
                sig.metrics.athMarketCap = athMarketCap;
                sig.metrics.athAt = new Date(maxAt);
                sig.metrics.timeToAth = timeToAth;
                sig.metrics.maxDrawdown = maxDrawdown;
                sig.metrics.updatedAt = new Date();
            } else {
                // CREATE
                const newMetrics = await prisma.signalMetric.create({
                    data: {
                        signalId: sig.id,
                        currentPrice: entryPriceValue, // Placeholder until current price update
                        currentMultiple: 1.0,
                        athMultiple,
                        athPrice: maxHigh,
                        athMarketCap,
                        athAt: new Date(maxAt),
                        timeToAth,
                        maxDrawdown
                    }
                });
                sig.metrics = newMetrics;
            }
        }
    } catch (err) {
        logger.debug(`Error enriching signal ${sig.id}: ${err}`);
    }
};

/**
 * Batched enrichment for a list of signals.
 * Handles parallel processing with rate limiting.
 */
export const enrichSignalsBatch = async (signals: SignalWithRelations[], force: boolean = false) => {
    const BATCH_SIZE = 5;
    const DELAY_BETWEEN_BATCHES = 500;
    
    // Filter out signals that don't need update unless forced
    const now = Date.now();
    const STALE_METRICS_MS = 5 * 60 * 1000;
    
    const toProcess = signals.filter(s => {
        if (force) return true;
        if (!s.metrics) return true;
        return (now - s.metrics.updatedAt.getTime()) > STALE_METRICS_MS;
    });

    for (let i = 0; i < toProcess.length; i += BATCH_SIZE) {
        const batch = toProcess.slice(i, i + BATCH_SIZE);
        await Promise.allSettled(batch.map(s => enrichSignalMetrics(s, force)));
        
        if (i + BATCH_SIZE < toProcess.length) {
            await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES));
        }
    }
};

/**
 * Update metrics for a single signal (Wrapper for enrichSignalMetrics to satisfy existing consumers if any).
 * @deprecated Use enrichSignalMetrics directly or enrichSignalsBatch
 */
export const updateSignalMetrics = async (signalId: number) => {
    try {
        const signal = await prisma.signal.findUnique({
            where: { id: signalId },
            include: { metrics: true, priceSamples: { orderBy: { sampledAt: 'asc' }, take: 1 } }
        });
        if (signal) {
            await enrichSignalMetrics(signal as any, true);
        }
    } catch (err) {
        logger.error(`Failed to update metrics for signal ${signalId}:`, err);
    }
};
