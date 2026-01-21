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
        const ageMs = nowTimestamp - entryTimestamp;

        let maxHigh = 0;
        let maxAt = entryTimestamp;

        const currentPrice = currentPriceOverride ?? sig.metrics?.currentPrice ?? 0;

        // Simplified OHLCV strategy:
        // < 1 hour: minute candles (single call)
        // 1 hour - 7 days: hourly candles (single call)
        // > 7 days: daily candles (single call)
        let timeframe: 'minute' | 'hour' | 'day' = 'hour';
        let unitMs = 60 * 60 * 1000;
        if (ageMs <= 60 * 60 * 1000) {
            timeframe = 'minute';
            unitMs = 60 * 1000;
        } else if (ageMs > 7 * 24 * 60 * 60 * 1000) {
            timeframe = 'day';
            unitMs = 24 * 60 * 60 * 1000;
        }

        const limit = Math.min(1000, Math.ceil(ageMs / unitMs) + 2);

        try {
            const candles = await geckoTerminal.getOHLCV(sig.mint, timeframe, limit);
            const postEntry = candles.filter((c) => c.timestamp >= entryTimestamp);
            for (const candle of postEntry) {
                if (candle.high > maxHigh) {
                    maxHigh = candle.high;
                    maxAt = candle.timestamp;
                }
            }
        } catch (err) {
            logger.debug(`GeckoTerminal ${timeframe} candles failed for ${sig.mint}: ${err}`);
        }

        // Ensure ATH is never below current price or entry price
        const fallbackPrice = Math.max(entryPriceValue, currentPrice || 0);
        if (maxHigh === 0 && fallbackPrice > 0) {
            maxHigh = fallbackPrice;
            maxAt = currentPrice >= entryPriceValue ? nowTimestamp : entryTimestamp;
        } else if (currentPrice > maxHigh) {
            maxHigh = currentPrice;
            maxAt = nowTimestamp;
        }

        // Never allow ATH to decrease below cached ATH price if it exists
        if (sig.metrics?.athPrice && sig.metrics.athPrice > maxHigh) {
            maxHigh = sig.metrics.athPrice;
            maxAt = sig.metrics.athAt?.getTime?.() || maxAt;
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
