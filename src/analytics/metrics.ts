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
 * Enriches a single signal with ATH metrics using robust "progressive boundary" logic.
 * Fetches candle data from GeckoTerminal and updates the DB.
 * @param sig Signal to enrich
 * @param force Force recalculation even if metrics are fresh
 */
export const enrichSignalMetrics = async (sig: SignalWithRelations, force: boolean = false): Promise<void> => {
    const STALE_METRICS_MS = 2 * 60 * 1000; // 2 minutes
    const now = Date.now();

    // Check if we need to calculate
    if (!force && sig.metrics?.updatedAt) {
        const age = now - sig.metrics.updatedAt.getTime();
        if (age < STALE_METRICS_MS) return; // Metrics are fresh enough
    }

    try {
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
        const entryDateObj = new Date(entryTimestamp);
        
        // PROGRESSIVE BOUNDARY CALCULATION
        const calculateNextBoundary = (date: Date, intervalMinutes: number): Date => {
            const result = new Date(date);
            const currentMinutes = result.getMinutes();
            const remainder = currentMinutes % intervalMinutes;
            if (remainder === 0) {
                result.setMinutes(currentMinutes + intervalMinutes);
            } else {
                result.setMinutes(currentMinutes + (intervalMinutes - remainder));
            }
            result.setSeconds(0);
            result.setMilliseconds(0);
            return result;
        };
        
        const next05Boundary = calculateNextBoundary(entryDateObj, 5);
        const next05Timestamp = next05Boundary.getTime();
        
        const next15Boundary = calculateNextBoundary(entryDateObj, 15);
        const next15Timestamp = next15Boundary.getTime();
        
        const next30Boundary = calculateNextBoundary(entryDateObj, 30);
        const next30Timestamp = next30Boundary.getTime();
        
        const nextHourBoundary = new Date(entryDateObj);
        nextHourBoundary.setMinutes(0, 0, 0);
        nextHourBoundary.setSeconds(0, 0);
        nextHourBoundary.setHours(nextHourBoundary.getHours() + 1);
        const nextHourTimestamp = nextHourBoundary.getTime();
        
        const nextDayBoundary = new Date(entryDateObj);
        nextDayBoundary.setHours(0, 0, 0, 0);
        nextDayBoundary.setDate(nextDayBoundary.getDate() + 1);
        const nextDayTimestamp = nextDayBoundary.getTime();
        
        const ageMs = nowTimestamp - entryTimestamp;
        const ageMinutes = Math.ceil(ageMs / (60 * 1000));
        const ageHours = Math.ceil(ageMs / (60 * 60 * 1000));
        const ageDays = Math.ceil(ageMs / (24 * 60 * 60 * 1000));

        let maxHigh = 0;
        let maxAt = entryTimestamp;

        // --- PHASE 1: Minute candles from entry until next :05 boundary ---
        if (nowTimestamp > entryTimestamp && next05Timestamp > entryTimestamp) {
            const minutesTo05 = Math.ceil((next05Timestamp - entryTimestamp) / (60 * 1000));
            const minuteLimit = Math.min(1000, minutesTo05 + 2);
            try {
                const minuteCandles = await geckoTerminal.getOHLCV(sig.mint, 'minute', minuteLimit);
                const postEntryMinutes = minuteCandles.filter((c) => c.timestamp >= entryTimestamp && c.timestamp < next05Timestamp);
                for (const candle of postEntryMinutes) {
                    if (candle.high > maxHigh) {
                        maxHigh = candle.high;
                        maxAt = candle.timestamp;
                    }
                }
            } catch (err) {
                logger.debug(`GeckoTerminal minute candles failed for ${sig.mint}: ${err}`);
            }
        }

        // --- PHASE 2: Minute candles from :05 boundary until next :15 boundary ---
        if (nowTimestamp > next05Timestamp && next15Timestamp > next05Timestamp) {
            const minutesTo15 = Math.ceil((next15Timestamp - next05Timestamp) / (60 * 1000));
            const minuteLimit = Math.min(1000, minutesTo15 + 2);
            try {
                const minuteCandles = await geckoTerminal.getOHLCV(sig.mint, 'minute', minuteLimit);
                const post05Minutes = minuteCandles.filter((c) => c.timestamp >= next05Timestamp && c.timestamp < next15Timestamp);
                for (const candle of post05Minutes) {
                    if (candle.high > maxHigh) {
                        maxHigh = candle.high;
                        maxAt = candle.timestamp;
                    }
                }
            } catch (err) {
                logger.debug(`GeckoTerminal minute candles (:05 to :15) failed for ${sig.mint}: ${err}`);
            }
        }

        // --- PHASE 3: Minute candles from :15 boundary until next hour (or :30 if closer) ---
        if (nowTimestamp > next15Timestamp) {
            const endBoundary = next30Timestamp < nextHourTimestamp && next30Timestamp > next15Timestamp 
                ? next30Timestamp 
                : nextHourTimestamp;
            
            if (endBoundary > next15Timestamp) {
                const minutesToEnd = Math.ceil((endBoundary - next15Timestamp) / (60 * 1000));
                const minuteLimit = Math.min(1000, minutesToEnd + 2);
                try {
                    const minuteCandles = await geckoTerminal.getOHLCV(sig.mint, 'minute', minuteLimit);
                    const post15Minutes = minuteCandles.filter((c) => c.timestamp >= next15Timestamp && c.timestamp < endBoundary);
                    for (const candle of post15Minutes) {
                        if (candle.high > maxHigh) {
                            maxHigh = candle.high;
                            maxAt = candle.timestamp;
                        }
                    }
                } catch (err) {
                    logger.debug(`GeckoTerminal minute candles (:15 to ${endBoundary === next30Timestamp ? ':30' : 'hour'}) failed for ${sig.mint}: ${err}`);
                }
            }
            
            // If we stopped at :30, continue with minute candles from :30 to hour
            if (endBoundary === next30Timestamp && nowTimestamp > next30Timestamp && nextHourTimestamp > next30Timestamp) {
                const minutesToHour = Math.ceil((nextHourTimestamp - next30Timestamp) / (60 * 1000));
                const minuteLimit = Math.min(1000, minutesToHour + 2);
                try {
                    const minuteCandles = await geckoTerminal.getOHLCV(sig.mint, 'minute', minuteLimit);
                    const post30Minutes = minuteCandles.filter((c) => c.timestamp >= next30Timestamp && c.timestamp < nextHourTimestamp);
                    for (const candle of post30Minutes) {
                        if (candle.high > maxHigh) {
                            maxHigh = candle.high;
                            maxAt = candle.timestamp;
                        }
                    }
                } catch (err) {
                    logger.debug(`GeckoTerminal minute candles (:30 to hour) failed for ${sig.mint}: ${err}`);
                }
            }
        }

        // --- PHASE 4: Hourly candles from next hour boundary onwards ---
        if (nowTimestamp > nextHourTimestamp && ageHours > 0) {
            let hourlyEndTimestamp = nowTimestamp;
            if (nowTimestamp > nextDayTimestamp) {
                hourlyEndTimestamp = nextDayTimestamp;
            }
            const hoursNeeded = Math.ceil((hourlyEndTimestamp - nextHourTimestamp) / (60 * 60 * 1000));
            const hourLimit = Math.min(1000, hoursNeeded + 1);
            try {
                const hourlyCandles = await geckoTerminal.getOHLCV(sig.mint, 'hour', hourLimit);
                const hourlyInRange = hourlyCandles.filter((c) => c.timestamp >= nextHourTimestamp && c.timestamp < hourlyEndTimestamp);
                for (const candle of hourlyInRange) {
                    if (candle.high > maxHigh) {
                        maxHigh = candle.high;
                        maxAt = candle.timestamp;
                    }
                }
            } catch (err) {
                logger.debug(`GeckoTerminal hourly candles failed for ${sig.mint}: ${err}`);
            }

            // --- PHASE 5: Daily candles if trade spans days ---
            if (nowTimestamp > nextDayTimestamp && ageDays > 0) {
                const daysNeeded = Math.ceil((nowTimestamp - nextDayTimestamp) / (24 * 60 * 60 * 1000));
                const dayLimit = Math.min(1000, daysNeeded + 1);
                try {
                    const dailyCandles = await geckoTerminal.getOHLCV(sig.mint, 'day', dayLimit);
                    const dailyInRange = dailyCandles.filter((c) => c.timestamp >= nextDayTimestamp && c.timestamp <= nowTimestamp);
                    for (const candle of dailyInRange) {
                        if (candle.high > maxHigh) {
                            maxHigh = candle.high;
                            maxAt = candle.timestamp;
                        }
                    }
                } catch (err) {
                    logger.debug(`GeckoTerminal daily candles failed for ${sig.mint}: ${err}`);
                }
            }
        } else if (ageHours === 0 && ageMinutes > 0 && nowTimestamp <= next05Timestamp) {
            // Very recent trade (< 1 hour and hasn't reached :05 yet) - just use minute candles
            const minuteLimit = Math.min(1000, ageMinutes + 10);
            try {
                const minuteCandles = await geckoTerminal.getOHLCV(sig.mint, 'minute', minuteLimit);
                const postEntryMinutes = minuteCandles.filter((c) => c.timestamp >= entryTimestamp);
                for (const candle of postEntryMinutes) {
                    if (candle.high > maxHigh) {
                        maxHigh = candle.high;
                        maxAt = candle.timestamp;
                    }
                }
            } catch (err) {
                logger.debug(`GeckoTerminal minute candles (recent) failed for ${sig.mint}: ${err}`);
            }
        }

        // Fallback: try all minute candles if maxHigh is still 0
        if (maxHigh === 0) {
            try {
                const allMinuteCandles = await geckoTerminal.getOHLCV(sig.mint, 'minute', 1000);
                const postEntryAllMinutes = allMinuteCandles.filter((c) => c.timestamp >= entryTimestamp);
                for (const candle of postEntryAllMinutes) {
                    if (candle.high > maxHigh) {
                        maxHigh = candle.high;
                        maxAt = candle.timestamp;
                    }
                }
            } catch (err) {
                logger.debug(`GeckoTerminal all-minute fallback failed for ${sig.mint}: ${err}`);
            }
        }

        // Calculate ATH multiple
        if (maxHigh > 0 && entryPriceValue > 0) {
            const athMultiple = maxHigh / entryPriceValue;
            
            // Validate against current price - ATH cannot be lower than current price
            // (Assuming we have current price from enrichSignalsWithCurrentPrice or elsewhere)
            if (sig.metrics?.currentPrice && sig.metrics.currentPrice > maxHigh) {
                maxHigh = sig.metrics.currentPrice;
                // re-calculate multiple?
            }

            // Update or create metrics for this signal
            const athMarketCap = entrySupply ? maxHigh * entrySupply : 0;
            const timeToAth = maxAt - entryTimestamp;

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
                        updatedAt: new Date()
                    }
                });
                // Update in-memory
                sig.metrics.athMultiple = athMultiple;
                sig.metrics.athPrice = maxHigh;
                sig.metrics.athMarketCap = athMarketCap;
                sig.metrics.athAt = new Date(maxAt);
                sig.metrics.timeToAth = timeToAth;
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
                        maxDrawdown: 0
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
    const STALE_METRICS_MS = 2 * 60 * 1000;
    
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
