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
        // OPTIMIZATION: Skip OHLCV if we have no activity since last update (volume check)
        // This prevents recalculating ATH for dead tokens with no volume
        if (!force && sig.metrics?.updatedAt) {
            const latestSample = await prisma.priceSample.findFirst({
                where: {
                    signalId: sig.id,
                    sampledAt: { gt: sig.metrics.updatedAt }
                },
                orderBy: { sampledAt: 'desc' }
            });
            // Skip if no new samples OR no volume in latest sample
            // But allow if metrics are very stale (> 1 hour) - might need update anyway
            const metricsAge = now - sig.metrics.updatedAt.getTime();
            if (!latestSample || (latestSample.volume ?? 0) <= 0) {
                // Only skip if metrics are relatively fresh (< 1 hour)
                // If very stale, recalculate anyway (might have missed activity)
                if (metricsAge < 60 * 60 * 1000) {
                    return;
                }
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

        logger.debug(`[Metrics] Starting GeckoTerminal OHLCV fetch for ${sig.mint.slice(0, 8)}... (entry: ${entryPriceValue}, current: ${currentPrice})`);

        // Minute candles: entry -> hour boundary
        if (nowTimestamp > entryTimestamp) {
            const minuteEnd = Math.min(hourBoundaryTs, nowTimestamp);
            if (minuteEnd > entryTimestamp) {
                const minutesNeeded = Math.ceil((minuteEnd - entryTimestamp) / (60 * 1000)) + 2;
                const minuteLimit = Math.min(1000, minutesNeeded);
                try {
                    logger.debug(`[Metrics] Fetching GeckoTerminal minute candles for ${sig.mint.slice(0, 8)}... (limit: ${minuteLimit})`);
                    const minuteCandles = await geckoTerminal.getOHLCV(sig.mint, 'minute', minuteLimit);
                    logger.debug(`[Metrics] Got ${minuteCandles.length} minute candles for ${sig.mint.slice(0, 8)}...`);
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
                    logger.debug(`[Metrics] Fetching GeckoTerminal hourly candles for ${sig.mint.slice(0, 8)}... (limit: ${hourLimit})`);
                    const hourlyCandles = await geckoTerminal.getOHLCV(sig.mint, 'hour', hourLimit);
                    logger.debug(`[Metrics] Got ${hourlyCandles.length} hourly candles for ${sig.mint.slice(0, 8)}...`);
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
                    logger.debug(`[Metrics] Fetching GeckoTerminal daily candles for ${sig.mint.slice(0, 8)}... (limit: ${dayLimit})`);
                    const dailyCandles = await geckoTerminal.getOHLCV(sig.mint, 'day', dayLimit);
                    logger.debug(`[Metrics] Got ${dailyCandles.length} daily candles for ${sig.mint.slice(0, 8)}...`);
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

        logger.debug(`[Metrics] Total candles found for ${sig.mint.slice(0, 8)}...: ${candlesFound} (from GeckoTerminal)`);
        
        if (candlesFound === 0) {
            logger.debug(`[Metrics] No candles found for ${sig.mint.slice(0, 8)}..., using cached ATH if available`);
            if (!sig.metrics?.athPrice || sig.metrics.athPrice <= 0) {
                logger.debug(`[Metrics] No cached ATH for ${sig.mint.slice(0, 8)}..., skipping`);
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
            logger.debug(`[Metrics] Calculated ATH for ${sig.mint.slice(0, 8)}...: ${athMultiple.toFixed(2)}x (price: ${maxHigh}, entry: ${entryPriceValue})`);

            // Calculate ATH market cap - use entrySupply if available, otherwise calculate from entryMarketCap
            let athMarketCap = 0;
            if (entrySupply && entrySupply > 0) {
                athMarketCap = maxHigh * entrySupply;
            } else if (sig.entryMarketCap && sig.entryMarketCap > 0) {
                // Fallback: calculate from entry market cap and ATH multiple
                athMarketCap = sig.entryMarketCap * athMultiple;
            }
            
            const timeToAth = maxAt - entryTimestamp;

            // Calculate max drawdown: find lowest price between entry and ATH time ONLY
            // Max drawdown = percentage decrease from entry price to lowest price in that period
            // CRITICAL: Drawdown always occurs BEFORE ATH, so we only check candles up to ATH time
            let maxDrawdown = 0;
            let maxDrawdownPrice = entryPriceValue; // Price at max drawdown
            let maxDrawdownAt = entryTimestamp; // Time of max drawdown
            
            if (allCandles.length > 0) {
                // Filter candles to ONLY those between entry and ATH time (same candles used for ATH)
                // Stop checking after ATH time - drawdown can only occur before ATH
                const candlesUpToAth = allCandles.filter(c => 
                    c.timestamp >= entryTimestamp && c.timestamp <= maxAt
                );
                
                // Find the lowest price (using candle.low) in the timeframe between entry and ATH
                // Start with entry price as baseline
                let lowestPrice = entryPriceValue;
                let lowestPriceAt = entryTimestamp;
                
                // Use the same candles that were used for ATH calculation
                for (const candle of candlesUpToAth) {
                    // Use the low of the candle to find the absolute lowest price
                    // This is the max drawdown point (lowest point before ATH)
                    if (candle.low < lowestPrice) {
                        lowestPrice = candle.low;
                        lowestPriceAt = candle.timestamp;
                    }
                }
                
                // Set max drawdown values
                maxDrawdownPrice = lowestPrice;
                maxDrawdownAt = lowestPriceAt;
                
                // Calculate max drawdown: percentage decrease from entry to lowest price
                // This is always negative (or 0 if no drawdown)
                if (entryPriceValue > 0) {
                    maxDrawdown = ((lowestPrice - entryPriceValue) / entryPriceValue) * 100;
                }
            } else {
                // If no OHLCV data, calculate simple drawdown from entry to current price
                // But only if current is below entry (drawdown)
                if (currentPrice > 0 && entryPriceValue > 0 && currentPrice < entryPriceValue) {
                    maxDrawdown = ((currentPrice - entryPriceValue) / entryPriceValue) * 100;
                    maxDrawdownPrice = currentPrice;
                    maxDrawdownAt = nowTimestamp;
                }
            }
            
            // Calculate max drawdown market cap
            let maxDrawdownMarketCap = 0;
            if (entrySupply && entrySupply > 0) {
                maxDrawdownMarketCap = maxDrawdownPrice * entrySupply;
            } else if (sig.entryMarketCap && sig.entryMarketCap > 0 && entryPriceValue > 0) {
                // Fallback: calculate from entry market cap and drawdown price ratio
                const drawdownMultiple = maxDrawdownPrice / entryPriceValue;
                maxDrawdownMarketCap = sig.entryMarketCap * drawdownMultiple;
            }
            
            // Calculate time from max drawdown to ATH
            // Since drawdown always occurs before ATH (we only check up to ATH time),
            // we can calculate this if we found a drawdown
            let timeFromDrawdownToAth: number | null = null;
            if (maxDrawdown < 0 && maxDrawdownAt < maxAt) {
                // Drawdown occurred before ATH, calculate recovery time
                timeFromDrawdownToAth = maxAt - maxDrawdownAt;
            } else if (maxDrawdown < 0 && maxDrawdownAt === entryTimestamp) {
                // Drawdown was at entry (never recovered), time to ATH is the recovery time
                timeFromDrawdownToAth = timeToAth;
            }

            // Store max drawdown market cap and time from drawdown to ATH in metrics for display
            
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
                        maxDrawdownMarketCap,
                        timeFromDrawdownToAth,
                        updatedAt: new Date()
                    }
                });
                // Update in-memory (store derived values for display)
                sig.metrics.athMultiple = athMultiple;
                sig.metrics.athPrice = maxHigh;
                sig.metrics.athMarketCap = athMarketCap;
                sig.metrics.athAt = new Date(maxAt);
                sig.metrics.timeToAth = timeToAth;
                sig.metrics.maxDrawdown = maxDrawdown;
                sig.metrics.maxDrawdownMarketCap = maxDrawdownMarketCap;
                sig.metrics.timeFromDrawdownToAth = timeFromDrawdownToAth;
                sig.metrics.updatedAt = new Date();
                // Store derived values for display (not in DB schema yet, but available in memory)
                (sig.metrics as any).maxDrawdownPrice = maxDrawdownPrice;
                (sig.metrics as any).maxDrawdownAt = new Date(maxDrawdownAt);
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
                        maxDrawdown,
                        maxDrawdownMarketCap,
                        timeFromDrawdownToAth
                    }
                });
                sig.metrics = newMetrics;
                // Store derived values for display
                (sig.metrics as any).maxDrawdownPrice = maxDrawdownPrice;
                (sig.metrics as any).maxDrawdownAt = new Date(maxDrawdownAt);
            }
        }
    } catch (err) {
        logger.debug(`Error enriching signal ${sig.id}: ${err}`);
    }
};

/**
 * Batched enrichment for a list of signals.
 * Handles parallel processing with rate limiting.
 * Optimized for speed: larger batches, longer delays between batches.
 */
export const enrichSignalsBatch = async (signals: SignalWithRelations[], force: boolean = false) => {
    // Optimized batch settings (similar to live signals ATH calculation)
    const BATCH_SIZE = 3; // Process 3 signals at a time
    const DELAY_BETWEEN_BATCHES_MS = 3000; // 3 seconds between batches
    const DELAY_BETWEEN_ITEMS_MS = 1000; // 1 second between items in same batch
    
    // Filter out signals that don't need update unless forced
    const now = Date.now();
    const STALE_METRICS_MS = 5 * 60 * 1000;
    
    const toProcess = signals.filter(s => {
        if (force) return true;
        if (!s.metrics) return true;
        return (now - s.metrics.updatedAt.getTime()) > STALE_METRICS_MS;
    });

    logger.info(`[Metrics] Enriching ${toProcess.length}/${signals.length} signals (${toProcess.length - signals.length} already fresh)`);

    // Process in batches with delays
    for (let i = 0; i < toProcess.length; i += BATCH_SIZE) {
        const batch = toProcess.slice(i, i + BATCH_SIZE);
        
        // Process items in batch with small delay between each
        for (let j = 0; j < batch.length; j++) {
            const signal = batch[j];
            try {
                await enrichSignalMetrics(signal, force);
            } catch (err) {
                logger.debug(`[Metrics] Failed to enrich signal ${signal.id}: ${err}`);
            }
            
            // Delay between items in same batch (except last item)
            if (j < batch.length - 1) {
                await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_ITEMS_MS));
            }
        }
        
        // Delay between batches (except after last batch)
        if (i + BATCH_SIZE < toProcess.length) {
            await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES_MS));
        }
    }
    
    logger.info(`[Metrics] Batch enrichment complete for ${toProcess.length} signals`);
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
