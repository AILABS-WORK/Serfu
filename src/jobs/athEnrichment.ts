import { prisma } from '../db';
import { logger } from '../utils/logger';
import { enrichSignalsWithCurrentPrice, enrichSignalsBatch } from '../analytics/metrics';
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
        // Step 1: Get ALL active signals (we'll fetch prices for all at once - Jupiter v3 is instant)
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

        if (signals.length === 0) {
            logger.info('[ATH Enrichment] No active signals');
            return;
        }

        // Step 2: Fetch current prices for ALL signals in ONE batch (Jupiter v3 is instant!)
        const uniqueMints = [...new Set(signals.map(s => s.mint))];
        logger.info(`[ATH Enrichment] Fetching current prices for ${uniqueMints.length} unique mints (Jupiter v3 batch - instant)`);
        
        const startTime = Date.now();
        const priceMap = await getMultipleTokenPrices(uniqueMints);
        const fetchTime = Date.now() - startTime;
        const pricesFound = Object.values(priceMap).filter(p => p !== null && p > 0).length;
        logger.info(`[ATH Enrichment] Got prices for ${pricesFound}/${uniqueMints.length} tokens in ${fetchTime}ms`);

        // Step 3: Smart filtering - determine which signals need ATH recalculation
        const signalsToCheck = signals.filter(s => {
            // Must have entry data
            if (!s.entryPrice || s.entryPrice <= 0) return false;
            
            // Must have current price
            const currentPrice = priceMap[s.mint];
            if (currentPrice === null || currentPrice === undefined || currentPrice <= 0) return false;
            
            return true;
        });

        // Step 4: Smart filtering - only enrich signals that might have new ATH
        const signalsToEnrich: typeof signalsToCheck = [];
        let skippedDead = 0;
        let skippedFresh = 0;
        let skippedNoChange = 0;
        
        for (const sig of signalsToCheck) {
            const currentPrice = priceMap[sig.mint]!; // Already validated above
            const entryPrice = sig.entryPrice!; // Already validated above
            
            // Calculate current multiple
            const currentMultiple = currentPrice / entryPrice;
            const storedAthMultiple = sig.metrics?.athMultiple || 1.0;
            const metricsAge = sig.metrics ? now - sig.metrics.updatedAt.getTime() : Infinity;
            
            // OPTIMIZATION 1: Skip if metrics are fresh (< 10 min old) and current < stored ATH
            // Fresh metrics + current below ATH = no new ATH possible, use cached
            if (metricsAge < STALE_METRICS_MS && currentMultiple < storedAthMultiple * 0.95) {
                skippedFresh++;
                continue;
            }
            
            // OPTIMIZATION 2: Skip if current multiple is way below stored ATH (token is dead)
            // If current is < 50% of stored ATH and current is < 0.5x, likely dead token
            if (storedAthMultiple > 1.0 && currentMultiple < storedAthMultiple * 0.5 && currentMultiple < 0.5) {
                skippedDead++;
                continue;
            }

            // OPTIMIZATION 3: Skip if current multiple is significantly below entry (dead token)
            // If current is < 0.1x (down 90%+) and stored ATH is also low, likely dead
            if (currentMultiple < 0.1 && storedAthMultiple < 1.5) {
                skippedDead++;
                continue;
            }

            // OPTIMIZATION 4: Check volume - skip if no recent volume (dead token)
            const latestSample = sig.priceSamples[0];
            if (latestSample) {
                const sampleAge = now - latestSample.sampledAt.getTime();
                // If last sample is > 1 hour old and had no volume, skip
                if (sampleAge > 60 * 60 * 1000 && (latestSample.volume ?? 0) <= 0) {
                    skippedDead++;
                    continue;
                }
            }

            // OPTIMIZATION 5: Only recalculate if current suggests ATH might have changed
            // If current multiple > stored ATH, definitely recalculate (new peak!)
            // If current multiple is close to stored ATH (within 10%), recalculate (might have hit new peak)
            // If no metrics yet, recalculate (initial calculation)
            // If metrics are very old (> 1 hour), recalculate anyway (safety check)
            const shouldRecalculate = 
                !sig.metrics || // No metrics yet - initial calculation
                currentMultiple > storedAthMultiple * 1.05 || // Current is 5%+ above stored ATH (new peak!)
                (currentMultiple > storedAthMultiple * 0.9 && metricsAge > STALE_METRICS_MS) || // Current within 10% of stored ATH and stale
                metricsAge > 60 * 60 * 1000; // Metrics are > 1 hour old (recalculate anyway)

            if (shouldRecalculate) {
                signalsToEnrich.push(sig);
            } else {
                skippedNoChange++;
            }
        }
        
        logger.info(`[ATH Enrichment] Smart filtering: ${signalsToEnrich.length} need ATH, ${skippedFresh} fresh (cached), ${skippedDead} dead (skipped), ${skippedNoChange} no change (skipped)`);

        if (signalsToEnrich.length === 0) {
            logger.info('[ATH Enrichment] No signals need ATH recalculation - all using cached ATH or skipped as dead');
            return;
        }

        // Step 4: Enrich signals with current price first (update in-memory)
        await enrichSignalsWithCurrentPrice(signalsToEnrich as any);

        // Step 5: Calculate ATH via GeckoTerminal (per-signal, rate-limited)
        await enrichSignalsBatch(signalsToEnrich as any, true);

        const enriched = signalsToEnrich.length;
        const failed = 0;

        const totalProcessed = signals.length;
        const totalSkipped = skippedFresh + skippedDead + skippedNoChange;
        logger.info(`[ATH Enrichment] Cycle complete: ${enriched} enriched, ${failed} failed, ${totalSkipped} skipped (${skippedFresh} fresh, ${skippedDead} dead, ${skippedNoChange} no change)`);
        logger.info(`[ATH Enrichment] Efficiency: ${((totalSkipped / totalProcessed) * 100).toFixed(1)}% skipped, ${((enriched / totalProcessed) * 100).toFixed(1)}% enriched`);
        
    } catch (error) {
        logger.error('[ATH Enrichment] Error in enrichment cycle:', error);
    }
};

