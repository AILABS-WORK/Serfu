import { prisma } from '../db';
import { logger } from '../utils/logger';
import { enrichSignalMetrics, enrichSignalsWithCurrentPrice } from '../analytics/metrics';
import { getMultipleTokenPrices } from '../providers/jupiter';

/**
 * Smart ATH enrichment job that runs periodically.
 * Only recalculates ATH for signals that might have a new ATH.
 * 
 * Optimization strategies:
 * 1. Skip signals at -99% that haven't moved (dead tokens)
 * 2. Only recalculate if current price suggests ATH might have changed
 * 3. Skip signals with no volume/activity
 * 4. Process in optimized batches
 */
export const runAthEnrichmentCycle = async () => {
    logger.info('[ATH Enrichment] Starting ATH enrichment cycle...');
    
    const STALE_METRICS_MS = 10 * 60 * 1000; // 10 minutes - only process stale metrics
    const now = Date.now();
    
    try {
        // Get all active signals with metrics
        const signals = await prisma.signal.findMany({
            where: {
                trackingStatus: { in: ['ACTIVE', 'ENTRY_PENDING'] }
            },
            include: {
                metrics: true,
                priceSamples: {
                    orderBy: { sampledAt: 'desc' },
                    take: 1 // Latest sample for volume check
                }
            }
        });

        logger.info(`[ATH Enrichment] Found ${signals.length} active signals`);

        // Step 1: Filter signals that need enrichment
        const signalsToCheck = signals.filter(s => {
            // Must have metrics
            if (!s.metrics) return true; // New signal, needs initial calculation
            
            // Must be stale
            const age = now - s.metrics.updatedAt.getTime();
            if (age < STALE_METRICS_MS) return false; // Fresh enough
            
            // Must have entry data
            if (!s.entryPrice || !s.entryMarketCap) return false;
            
            return true;
        });

        logger.info(`[ATH Enrichment] ${signalsToCheck.length} signals have stale metrics`);

        if (signalsToCheck.length === 0) {
            logger.info('[ATH Enrichment] No signals need enrichment');
            return;
        }

        // Step 2: Fetch current prices for all signals in batch (FAST)
        const uniqueMints = [...new Set(signalsToCheck.map(s => s.mint))];
        logger.info(`[ATH Enrichment] Fetching current prices for ${uniqueMints.length} unique mints`);
        
        const priceMap = await getMultipleTokenPrices(uniqueMints);
        const pricesFound = Object.values(priceMap).filter(p => p !== null && p > 0).length;
        logger.info(`[ATH Enrichment] Got prices for ${pricesFound}/${uniqueMints.length} tokens`);

        // Step 3: Smart filtering - only enrich signals that might have new ATH
        const signalsToEnrich: typeof signalsToCheck = [];
        
        for (const sig of signalsToCheck) {
            const currentPrice = priceMap[sig.mint];
            
            // Skip if no current price
            if (currentPrice === null || currentPrice === undefined || currentPrice <= 0) {
                continue;
            }

            // Skip if no entry price
            if (!sig.entryPrice || sig.entryPrice <= 0) {
                continue;
            }

            // Calculate current multiple
            const currentMultiple = currentPrice / sig.entryPrice;
            const storedAthMultiple = sig.metrics?.athMultiple || 1.0;
            
            // OPTIMIZATION 1: Skip if current multiple is way below stored ATH (token is dead)
            // If current is < 50% of stored ATH and current is < 0.5x, likely dead token
            if (storedAthMultiple > 1.0 && currentMultiple < storedAthMultiple * 0.5 && currentMultiple < 0.5) {
                // Token is at -50% or worse and ATH was higher - likely dead, skip
                continue;
            }

            // OPTIMIZATION 2: Skip if current multiple is significantly below entry (dead token)
            // If current is < 0.1x (down 90%+) and stored ATH is also low, likely dead
            if (currentMultiple < 0.1 && storedAthMultiple < 1.5) {
                // Token is down 90%+ and never hit a good ATH - likely dead, skip
                continue;
            }

            // OPTIMIZATION 3: Check volume - skip if no recent volume
            const latestSample = sig.priceSamples[0];
            if (latestSample) {
                const sampleAge = now - latestSample.sampledAt.getTime();
                // If last sample is > 1 hour old and had no volume, skip
                if (sampleAge > 60 * 60 * 1000 && (latestSample.volume ?? 0) <= 0) {
                    continue;
                }
            }

            // OPTIMIZATION 4: Only recalculate if current suggests ATH might have changed
            // If current multiple > stored ATH, definitely recalculate
            // If current multiple is close to stored ATH (within 10%), recalculate (might have hit new ATH)
            // If stored ATH is very old (> 1 hour), recalculate anyway
            const metricsAge = sig.metrics ? now - sig.metrics.updatedAt.getTime() : Infinity;
            const shouldRecalculate = 
                currentMultiple > storedAthMultiple * 1.05 || // Current is 5%+ above stored ATH
                currentMultiple > storedAthMultiple * 0.9 || // Current is within 10% of stored ATH (might have hit new peak)
                metricsAge > 60 * 60 * 1000; // Metrics are > 1 hour old (recalculate anyway)

            if (shouldRecalculate) {
                signalsToEnrich.push(sig);
            }
        }

        logger.info(`[ATH Enrichment] Smart filtering: ${signalsToEnrich.length}/${signalsToCheck.length} signals need ATH recalculation`);

        if (signalsToEnrich.length === 0) {
            logger.info('[ATH Enrichment] No signals need ATH recalculation after smart filtering');
            return;
        }

        // Step 4: Enrich signals with current price first (update in-memory)
        await enrichSignalsWithCurrentPrice(signalsToEnrich as any);

        // Step 5: Calculate ATH in optimized batches
        const BATCH_SIZE = 3; // Process 3 at a time
        const DELAY_BETWEEN_BATCHES_MS = 3000; // 3 seconds between batches
        const DELAY_BETWEEN_ITEMS_MS = 1000; // 1 second between items

        let enriched = 0;
        let failed = 0;

        for (let i = 0; i < signalsToEnrich.length; i += BATCH_SIZE) {
            const batch = signalsToEnrich.slice(i, i + BATCH_SIZE);
            
            // Process items in batch with delay
            for (let j = 0; j < batch.length; j++) {
                const signal = batch[j];
                const currentPrice = priceMap[signal.mint];
                
                if (currentPrice !== null && currentPrice > 0) {
                    try {
                        await enrichSignalMetrics(signal as any, false, currentPrice);
                        enriched++;
                    } catch (err) {
                        logger.debug(`[ATH Enrichment] Failed to enrich signal ${signal.id}: ${err}`);
                        failed++;
                    }
                }
                
                // Delay between items (except last)
                if (j < batch.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_ITEMS_MS));
                }
            }
            
            // Delay between batches (except last)
            if (i + BATCH_SIZE < signalsToEnrich.length) {
                await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES_MS));
            }
        }

        logger.info(`[ATH Enrichment] Cycle complete: ${enriched} enriched, ${failed} failed, ${signalsToEnrich.length - enriched - failed} skipped`);
        
    } catch (error) {
        logger.error('[ATH Enrichment] Error in enrichment cycle:', error);
    }
};

