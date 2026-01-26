import { prisma } from '../db';
import { geckoTerminal, OHLCV } from '../providers/geckoTerminal';
import { getMultipleTokenPrices } from '../providers/jupiter';
import { logger } from '../utils/logger';
import { getEntryTime } from '../analytics/metricsUtils';

// ============================================================================
// TYPES
// ============================================================================

export interface BackfillProgress {
  status: 'idle' | 'running' | 'paused' | 'complete' | 'error';
  phase: 'init' | 'ohlcv_fetch' | 'processing' | 'complete';
  
  // Overall progress
  totalMints: number;
  processedMints: number;
  totalSignals: number;
  processedSignals: number;
  
  // Current batch info
  currentMint: string | null;
  currentBatchIndex: number;
  batchSize: number;
  
  // Timing
  startedAt: Date | null;
  updatedAt: Date | null;
  endedAt: Date | null;
  estimatedTimeRemaining: number | null; // ms
  
  // Stats
  athUpdatedCount: number;
  errorCount: number;
  skippedCount: number;
  lastError: string | null;
  
  // Rate limiting
  ohlcvCallsRemaining: number;
  ohlcvCallsTotal: number;
}

interface MintEntry {
  mint: string;
  signals: Array<{
    id: number;
    entryPrice: number;
    entrySupply: number | null;
    entryMarketCap: number | null;
    entryTimestamp: number;
  }>;
  earliestEntry: number;
}

// ============================================================================
// STATE MANAGEMENT
// ============================================================================

const backfillState: BackfillProgress = {
  status: 'idle',
  phase: 'init',
  totalMints: 0,
  processedMints: 0,
  totalSignals: 0,
  processedSignals: 0,
  currentMint: null,
  currentBatchIndex: 0,
  batchSize: 50,
  startedAt: null,
  updatedAt: null,
  endedAt: null,
  estimatedTimeRemaining: null,
  athUpdatedCount: 0,
  errorCount: 0,
  skippedCount: 0,
  lastError: null,
  ohlcvCallsRemaining: 0,
  ohlcvCallsTotal: 0
};

let backfillAbortController: AbortController | null = null;

export const getBackfillProgress = (): BackfillProgress => ({ ...backfillState });

const updateProgress = (patch: Partial<BackfillProgress>) => {
  Object.assign(backfillState, patch);
  backfillState.updatedAt = new Date();
  
  // Calculate ETA
  if (backfillState.status === 'running' && backfillState.processedMints > 0) {
    const elapsed = Date.now() - (backfillState.startedAt?.getTime() || Date.now());
    const avgPerMint = elapsed / backfillState.processedMints;
    const remaining = backfillState.totalMints - backfillState.processedMints;
    backfillState.estimatedTimeRemaining = avgPerMint * remaining;
  }
};

// ============================================================================
// SMART OHLCV RESOLUTION
// ============================================================================

/**
 * Determines the optimal timeframe sequence for OHLCV fetching.
 * Uses minutes until the next hour, then hours until the next daily candle, then daily.
 */
const getSmartTimeframes = (fromTimestamp: number, toTimestamp: number): Array<{
  timeframe: 'minute' | 'hour' | 'day';
  from: number;
  to: number;
  limit: number;
}> => {
  const timeframes: Array<{
    timeframe: 'minute' | 'hour' | 'day';
    from: number;
    to: number;
    limit: number;
  }> = [];
  
  const MINUTE_MS = 60 * 1000;
  const HOUR_MS = 60 * MINUTE_MS;
  const DAY_MS = 24 * HOUR_MS;
  
  let cursor = fromTimestamp;
  
  // Phase 1: Minutes until the next hour boundary
  const nextHourBoundary = Math.ceil(cursor / HOUR_MS) * HOUR_MS;
  if (nextHourBoundary < toTimestamp && nextHourBoundary - cursor > 0) {
    const minutesToNextHour = Math.min(
      Math.ceil((nextHourBoundary - cursor) / MINUTE_MS),
      60
    );
    if (minutesToNextHour > 0 && minutesToNextHour <= 1000) {
      timeframes.push({
        timeframe: 'minute',
        from: cursor,
        to: nextHourBoundary,
        limit: minutesToNextHour + 5 // Buffer for overlap
      });
      cursor = nextHourBoundary;
    }
  }
  
  // Phase 2: Hours until the next daily boundary
  if (cursor < toTimestamp) {
    const nextDayBoundary = Math.ceil(cursor / DAY_MS) * DAY_MS;
    if (nextDayBoundary < toTimestamp && nextDayBoundary - cursor > HOUR_MS) {
      const hoursToNextDay = Math.min(
        Math.ceil((nextDayBoundary - cursor) / HOUR_MS),
        24
      );
      if (hoursToNextDay > 0 && hoursToNextDay <= 1000) {
        timeframes.push({
          timeframe: 'hour',
          from: cursor,
          to: nextDayBoundary,
          limit: hoursToNextDay + 5
        });
        cursor = nextDayBoundary;
      }
    }
  }
  
  // Phase 3: Remaining time with appropriate resolution
  if (cursor < toTimestamp) {
    const remainingMs = toTimestamp - cursor;
    const remainingHours = remainingMs / HOUR_MS;
    const remainingDays = remainingMs / DAY_MS;
    
    if (remainingHours <= 16) {
      // Use minute candles for recent data (max 1000 candles = ~16.6 hours)
      timeframes.push({
        timeframe: 'minute',
        from: cursor,
        to: toTimestamp,
        limit: Math.min(1000, Math.ceil(remainingMs / MINUTE_MS) + 5)
      });
    } else if (remainingDays <= 41) {
      // Use hour candles (max 1000 candles = ~41 days)
      timeframes.push({
        timeframe: 'hour',
        from: cursor,
        to: toTimestamp,
        limit: Math.min(1000, Math.ceil(remainingHours) + 5)
      });
    } else {
      // Use daily candles for older data
      timeframes.push({
        timeframe: 'day',
        from: cursor,
        to: toTimestamp,
        limit: Math.min(1000, Math.ceil(remainingDays) + 5)
      });
    }
  }
  
  // If no timeframes calculated, use a simple approach
  if (timeframes.length === 0) {
    const totalMs = toTimestamp - fromTimestamp;
    const totalHours = totalMs / HOUR_MS;
    
    if (totalHours <= 16) {
      timeframes.push({
        timeframe: 'minute',
        from: fromTimestamp,
        to: toTimestamp,
        limit: Math.min(1000, Math.ceil(totalMs / MINUTE_MS) + 5)
      });
    } else if (totalHours <= 720) {
      timeframes.push({
        timeframe: 'hour',
        from: fromTimestamp,
        to: toTimestamp,
        limit: Math.min(1000, Math.ceil(totalHours) + 5)
      });
    } else {
      timeframes.push({
        timeframe: 'day',
        from: fromTimestamp,
        to: toTimestamp,
        limit: Math.min(1000, Math.ceil(totalMs / DAY_MS) + 5)
      });
    }
  }
  
  return timeframes;
};

/**
 * Fetches OHLCV data using smart resolution.
 * Combines multiple timeframe fetches into a single sorted candle array.
 */
const fetchSmartOHLCV = async (
  mint: string,
  fromTimestamp: number,
  toTimestamp: number,
  abortSignal?: AbortSignal
): Promise<OHLCV[]> => {
  const fetchStart = Date.now();
  const timeframes = getSmartTimeframes(fromTimestamp, toTimestamp);
  const allCandles: OHLCV[] = [];
  
  logger.info(`[ATH Backfill] 📊 OHLCV fetch for ${mint.slice(0, 8)}...: ${timeframes.length} timeframe(s), range ${new Date(fromTimestamp).toISOString()} to ${new Date(toTimestamp).toISOString()}`);
  
  for (const tf of timeframes) {
    if (abortSignal?.aborted) throw new Error('Backfill aborted');
    
    const tfStart = Date.now();
    try {
      logger.debug(`[ATH Backfill] 🔄 Fetching ${tf.timeframe} x${tf.limit} for ${mint.slice(0, 8)}...`);
      const candles = await geckoTerminal.getOHLCV(mint, tf.timeframe, tf.limit);
      
      // Filter candles to the requested time range
      const filtered = candles.filter(c => c.timestamp >= tf.from - 300000 && c.timestamp <= tf.to + 300000);
      allCandles.push(...filtered);
      
      const tfDuration = Date.now() - tfStart;
      logger.debug(`[ATH Backfill] ✓ Got ${candles.length} candles (${filtered.length} in range) for ${mint.slice(0, 8)}... in ${tfDuration}ms`);
      
      // Small delay between timeframe fetches
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      const tfDuration = Date.now() - tfStart;
      logger.warn(`[ATH Backfill] ✗ Failed ${tf.timeframe} for ${mint.slice(0, 8)}... after ${tfDuration}ms: ${err}`);
    }
  }
  
  // Deduplicate and sort by timestamp
  const uniqueCandles = new Map<number, OHLCV>();
  for (const c of allCandles) {
    // Round to nearest minute to avoid duplicates from overlapping fetches
    const key = Math.round(c.timestamp / 60000) * 60000;
    const existing = uniqueCandles.get(key);
    if (!existing || c.timestamp > existing.timestamp) {
      uniqueCandles.set(key, c);
    }
  }
  
  const totalDuration = Date.now() - fetchStart;
  const result = Array.from(uniqueCandles.values()).sort((a, b) => a.timestamp - b.timestamp);
  logger.info(`[ATH Backfill] 📊 OHLCV complete for ${mint.slice(0, 8)}...: ${result.length} unique candles in ${totalDuration}ms`);
  
  return result;
};

// ============================================================================
// CORE BACKFILL LOGIC
// ============================================================================

/**
 * Process a single mint's OHLCV data and update all associated signals.
 */
const processMintBackfill = async (
  entry: MintEntry,
  candles: OHLCV[],
  abortSignal?: AbortSignal
): Promise<{ updated: number; errors: number; skipped: number }> => {
  const processStart = Date.now();
  let updated = 0;
  let errors = 0;
  let skipped = 0;
  
  if (candles.length === 0) {
    skipped = entry.signals.length;
    logger.debug(`[ATH Backfill] ⏭️ Skipped ${entry.mint.slice(0, 8)}...: no candles, ${skipped} signals skipped`);
    return { updated, errors, skipped };
  }
  
  logger.debug(`[ATH Backfill] 🔢 Processing ${entry.signals.length} signals for ${entry.mint.slice(0, 8)}... with ${candles.length} candles`);
  
  for (const signal of entry.signals) {
    if (abortSignal?.aborted) throw new Error('Backfill aborted');
    
    try {
      const entryPrice = signal.entryPrice;
      const entryTimestamp = signal.entryTimestamp;
      
      // Filter candles from entry time onwards
      const validCandles = candles.filter(c => c.timestamp >= entryTimestamp - 300000);
      
      if (validCandles.length === 0) {
        skipped++;
        continue;
      }
      
      // Calculate ATH
      let athPrice = entryPrice;
      let athAt = entryTimestamp;
      let minLowPrice = entryPrice;
      let minLowAt = entryTimestamp;
      let timeTo2x: number | null = null;
      let timeTo3x: number | null = null;
      let timeTo5x: number | null = null;
      let timeTo10x: number | null = null;
      
      // Track lowest before ATH for drawdown
      let lowestBeforeAth = entryPrice;
      let lowestBeforeAthAt = entryTimestamp;
      
      for (const candle of validCandles) {
        // Track ATH
        if (candle.high > athPrice) {
          // Before updating ATH, record the lowest point up to now
          lowestBeforeAth = minLowPrice;
          lowestBeforeAthAt = minLowAt;
          
          athPrice = candle.high;
          athAt = candle.timestamp;
        }
        
        // Track overall low
        if (candle.low < minLowPrice) {
          minLowPrice = candle.low;
          minLowAt = candle.timestamp;
        }
        
        // Track time to multiples (only set once)
        if (timeTo2x === null && candle.high >= entryPrice * 2) {
          timeTo2x = candle.timestamp - entryTimestamp;
        }
        if (timeTo3x === null && candle.high >= entryPrice * 3) {
          timeTo3x = candle.timestamp - entryTimestamp;
        }
        if (timeTo5x === null && candle.high >= entryPrice * 5) {
          timeTo5x = candle.timestamp - entryTimestamp;
        }
        if (timeTo10x === null && candle.high >= entryPrice * 10) {
          timeTo10x = candle.timestamp - entryTimestamp;
        }
      }
      
      // Ensure ATH >= entry price
      if (athPrice < entryPrice) {
        athPrice = entryPrice;
        athAt = entryTimestamp;
      }
      
      // Calculate metrics
      const athMultiple = athPrice / entryPrice;
      const maxDrawdown = lowestBeforeAth < entryPrice
        ? ((lowestBeforeAth - entryPrice) / entryPrice) * 100
        : 0;
      const timeToAth = athAt - entryTimestamp;
      const timeToDrawdown = lowestBeforeAthAt - entryTimestamp;
      const timeFromDrawdownToAth = lowestBeforeAthAt < athAt
        ? athAt - lowestBeforeAthAt
        : null;
      
      // Calculate market caps
      const entrySupply = signal.entrySupply ||
        (signal.entryMarketCap && entryPrice > 0 ? signal.entryMarketCap / entryPrice : null);
      const athMarketCap = entrySupply ? athPrice * entrySupply :
        (signal.entryMarketCap ? signal.entryMarketCap * athMultiple : null);
      const maxDrawdownMarketCap = entrySupply && lowestBeforeAth
        ? lowestBeforeAth * entrySupply
        : null;
      
      // Get current price from last candle
      const lastCandle = validCandles[validCandles.length - 1];
      const currentPrice = lastCandle.close;
      const currentMultiple = currentPrice / entryPrice;
      const currentMarketCap = entrySupply ? currentPrice * entrySupply : null;
      
      // Upsert metrics
      await prisma.signalMetric.upsert({
        where: { signalId: signal.id },
        create: {
          signalId: signal.id,
          currentPrice,
          currentMultiple,
          currentMarketCap,
          athPrice,
          athMultiple,
          athMarketCap,
          athAt: new Date(athAt),
          timeToAth,
          maxDrawdown,
          maxDrawdownMarketCap,
          timeFromDrawdownToAth,
          timeToDrawdown,
          timeTo2x,
          timeTo3x,
          timeTo5x,
          timeTo10x,
          ohlcvLastAt: new Date(lastCandle.timestamp),
          minLowPrice,
          minLowAt: new Date(minLowAt),
          updatedAt: new Date()
        },
        update: {
          currentPrice,
          currentMultiple,
          currentMarketCap,
          athPrice,
          athMultiple,
          athMarketCap,
          athAt: new Date(athAt),
          timeToAth,
          maxDrawdown,
          maxDrawdownMarketCap,
          timeFromDrawdownToAth,
          timeToDrawdown,
          timeTo2x,
          timeTo3x,
          timeTo5x,
          timeTo10x,
          ohlcvLastAt: new Date(lastCandle.timestamp),
          minLowPrice,
          minLowAt: new Date(minLowAt),
          updatedAt: new Date()
        }
      });
      
      updated++;
    } catch (err) {
      logger.debug(`[ATH Backfill] Error processing signal ${signal.id}: ${err}`);
      errors++;
    }
  }
  
  const processDuration = Date.now() - processStart;
  logger.debug(`[ATH Backfill] ✓ Finished ${entry.mint.slice(0, 8)}...: ${updated}✓ ${errors}✗ ${skipped}⏭️ in ${processDuration}ms`);
  
  return { updated, errors, skipped };
};

// ============================================================================
// MAIN BACKFILL FUNCTION
// ============================================================================

/**
 * Starts the full ATH backfill process.
 * 
 * Flow:
 * 1. Get all signals with entry data
 * 2. Deduplicate by mint (one entry per unique mint)
 * 3. For each mint, fetch OHLCV from earliest entry to now
 * 4. Process all signals for that mint
 * 5. Update progress and continue
 */
export const startAthBackfill = async (options?: {
  batchSize?: number;
  onlyActiveSince?: Date;
  forceRefresh?: boolean;
}) => {
  // Check if already running
  if (backfillState.status === 'running') {
    logger.warn('[ATH Backfill] Backfill already running');
    return;
  }
  
  // Create abort controller for cancellation
  backfillAbortController = new AbortController();
  const abortSignal = backfillAbortController.signal;
  
  const batchSize = options?.batchSize || 50;
  
  try {
    logger.info('[ATH Backfill] Starting full ATH backfill...');
    
    // Initialize progress
    updateProgress({
      status: 'running',
      phase: 'init',
      startedAt: new Date(),
      endedAt: null,
      athUpdatedCount: 0,
      errorCount: 0,
      skippedCount: 0,
      lastError: null,
      batchSize
    });
    
    // Step 1: Get all signals with entry data
    const whereClause: any = {
      entryPrice: { not: null, gt: 0 }
    };
    
    if (options?.onlyActiveSince) {
      whereClause.OR = [
        { entryPriceAt: { gte: options.onlyActiveSince } },
        { entryPriceAt: null, detectedAt: { gte: options.onlyActiveSince } }
      ];
    }
    
    // Skip if metrics already exist and forceRefresh is false
    if (!options?.forceRefresh) {
      whereClause.OR = [
        { metrics: null },
        { metrics: { athPrice: { lte: 0 } } },
        { metrics: { athMultiple: { lte: 1 } } }
      ];
    }
    
    const signals = await prisma.signal.findMany({
      where: whereClause,
      select: {
        id: true,
        mint: true,
        entryPrice: true,
        entrySupply: true,
        entryMarketCap: true,
        entryPriceAt: true,
        detectedAt: true
      },
      orderBy: { detectedAt: 'asc' }
    });
    
    logger.info(`[ATH Backfill] Found ${signals.length} signals to process`);
    
    // Step 2: Group by mint and find earliest entry for each
    const mintMap = new Map<string, MintEntry>();
    
    for (const sig of signals) {
      if (!sig.entryPrice || sig.entryPrice <= 0) continue;
      
      const entryTime = getEntryTime(sig);
      if (!entryTime) continue;
      
      const entryTimestamp = entryTime.getTime();
      
      if (!mintMap.has(sig.mint)) {
        mintMap.set(sig.mint, {
          mint: sig.mint,
          signals: [],
          earliestEntry: entryTimestamp
        });
      }
      
      const entry = mintMap.get(sig.mint)!;
      entry.signals.push({
        id: sig.id,
        entryPrice: sig.entryPrice,
        entrySupply: sig.entrySupply,
        entryMarketCap: sig.entryMarketCap,
        entryTimestamp
      });
      
      if (entryTimestamp < entry.earliestEntry) {
        entry.earliestEntry = entryTimestamp;
      }
    }
    
    const mints = Array.from(mintMap.values());
    const totalSignals = signals.length;
    const totalMints = mints.length;
    
    updateProgress({
      phase: 'ohlcv_fetch',
      totalMints,
      totalSignals,
      processedMints: 0,
      processedSignals: 0,
      ohlcvCallsTotal: totalMints,
      ohlcvCallsRemaining: totalMints
    });
    
    logger.info(`[ATH Backfill] Processing ${totalMints} unique mints for ${totalSignals} signals`);
    
    // Step 3: Process in batches
    const now = Date.now();
    const overallStart = Date.now();
    let totalOhlcvTime = 0;
    let totalProcessTime = 0;
    let totalApiCalls = 0;
    
    logger.info(`[ATH Backfill] ════════════════════════════════════════════════════════════`);
    logger.info(`[ATH Backfill] 🚀 Starting batch processing: ${totalMints} mints, batch size ${batchSize}`);
    logger.info(`[ATH Backfill] ════════════════════════════════════════════════════════════`);
    
    for (let i = 0; i < mints.length; i += batchSize) {
      if (abortSignal.aborted) {
        logger.info('[ATH Backfill] ⛔ Aborted by user');
        updateProgress({ status: 'paused', lastError: 'Aborted by user' });
        return;
      }
      
      const batch = mints.slice(i, i + batchSize);
      const batchNum = Math.floor(i / batchSize) + 1;
      const totalBatches = Math.ceil(mints.length / batchSize);
      const batchStart = Date.now();
      
      logger.info(`[ATH Backfill] ────────────────────────────────────────────────────────`);
      logger.info(`[ATH Backfill] 📦 BATCH ${batchNum}/${totalBatches}: ${batch.length} mints`);
      
      updateProgress({
        currentBatchIndex: batchNum - 1,
        ohlcvCallsRemaining: totalMints - i
      });
      
      // Process batch in parallel (limited concurrency)
      const PARALLEL_LIMIT = 3; // GeckoTerminal rate limit friendly
      
      for (let j = 0; j < batch.length; j += PARALLEL_LIMIT) {
        if (abortSignal.aborted) break;
        
        const parallelBatch = batch.slice(j, j + PARALLEL_LIMIT);
        const subBatchNum = Math.floor(j / PARALLEL_LIMIT) + 1;
        const totalSubBatches = Math.ceil(batch.length / PARALLEL_LIMIT);
        
        logger.debug(`[ATH Backfill] Sub-batch ${subBatchNum}/${totalSubBatches}: processing ${parallelBatch.length} mints in parallel`);
        
        await Promise.all(parallelBatch.map(async (entry) => {
          if (abortSignal.aborted) return;
          
          updateProgress({ currentMint: entry.mint });
          
          try {
            const mintStart = Date.now();
            
            // Fetch OHLCV with smart resolution
            const ohlcvStart = Date.now();
            const candles = await fetchSmartOHLCV(
              entry.mint,
              entry.earliestEntry,
              now,
              abortSignal
            );
            const ohlcvDuration = Date.now() - ohlcvStart;
            totalOhlcvTime += ohlcvDuration;
            totalApiCalls++;
            
            // Process all signals for this mint
            const processStart = Date.now();
            const result = await processMintBackfill(entry, candles, abortSignal);
            const processDuration = Date.now() - processStart;
            totalProcessTime += processDuration;
            
            const totalMintDuration = Date.now() - mintStart;
            
            updateProgress({
              processedMints: backfillState.processedMints + 1,
              processedSignals: backfillState.processedSignals + entry.signals.length,
              athUpdatedCount: backfillState.athUpdatedCount + result.updated,
              errorCount: backfillState.errorCount + result.errors,
              skippedCount: backfillState.skippedCount + result.skipped
            });
            
            logger.info(`[ATH Backfill] ✓ ${entry.mint.slice(0, 8)}...: ${candles.length} candles, ${result.updated}✓ ${result.errors}✗ ${result.skipped}⏭️ (ohlcv: ${ohlcvDuration}ms, process: ${processDuration}ms, total: ${totalMintDuration}ms)`);
            
          } catch (err: any) {
            logger.error(`[ATH Backfill] ✗ Error ${entry.mint.slice(0, 8)}...: ${err.message}`);
            updateProgress({
              processedMints: backfillState.processedMints + 1,
              processedSignals: backfillState.processedSignals + entry.signals.length,
              errorCount: backfillState.errorCount + entry.signals.length,
              lastError: err.message
            });
          }
        }));
        
        // Rate limit delay between parallel batches
        if (j + PARALLEL_LIMIT < batch.length) {
          await new Promise(r => setTimeout(r, 2000));
        }
      }
      
      const batchDuration = Date.now() - batchStart;
      const avgOhlcvTime = totalApiCalls > 0 ? Math.round(totalOhlcvTime / totalApiCalls) : 0;
      const avgProcessTime = totalApiCalls > 0 ? Math.round(totalProcessTime / totalApiCalls) : 0;
      
      // Progress log
      const progress = ((i + batch.length) / totalMints * 100).toFixed(1);
      const eta = backfillState.estimatedTimeRemaining
        ? `ETA: ${Math.round(backfillState.estimatedTimeRemaining / 1000 / 60)}m`
        : '';
      
      logger.info(`[ATH Backfill] 📊 BATCH ${batchNum} COMPLETE in ${batchDuration}ms`);
      logger.info(`[ATH Backfill] 📊 Overall: ${progress}% (${i + batch.length}/${totalMints} mints) ${eta}`);
      logger.info(`[ATH Backfill] 📊 Stats: ${backfillState.athUpdatedCount} ATH updated, ${backfillState.errorCount} errors, ${backfillState.skippedCount} skipped`);
      logger.info(`[ATH Backfill] 📊 Avg times: OHLCV=${avgOhlcvTime}ms, Process=${avgProcessTime}ms`);
      
      // Batch delay
      if (i + batchSize < mints.length) {
        await new Promise(r => setTimeout(r, 3000));
      }
    }
    
    // Complete
    updateProgress({
      status: 'complete',
      phase: 'complete',
      currentMint: null,
      endedAt: new Date(),
      estimatedTimeRemaining: 0
    });
    
    const totalDuration = Date.now() - overallStart;
    const durationMin = Math.round(totalDuration / 1000 / 60);
    const avgPerMint = totalMints > 0 ? Math.round(totalDuration / totalMints) : 0;
    const avgOhlcvTime = totalApiCalls > 0 ? Math.round(totalOhlcvTime / totalApiCalls) : 0;
    const avgProcessTime = totalApiCalls > 0 ? Math.round(totalProcessTime / totalApiCalls) : 0;
    
    logger.info(`[ATH Backfill] ════════════════════════════════════════════════════════════`);
    logger.info(`[ATH Backfill] ✅ BACKFILL COMPLETE`);
    logger.info(`[ATH Backfill] ════════════════════════════════════════════════════════════`);
    logger.info(`[ATH Backfill] 📊 Duration: ${durationMin}m (${totalDuration}ms)`);
    logger.info(`[ATH Backfill] 📊 Mints: ${totalMints} processed`);
    logger.info(`[ATH Backfill] 📊 Signals: ${backfillState.processedSignals} processed`);
    logger.info(`[ATH Backfill] 📊 Results: ${backfillState.athUpdatedCount} ATH updated, ${backfillState.errorCount} errors, ${backfillState.skippedCount} skipped`);
    logger.info(`[ATH Backfill] 📊 API Calls: ${totalApiCalls} OHLCV fetches`);
    logger.info(`[ATH Backfill] 📊 Avg Time Per Mint: ${avgPerMint}ms`);
    logger.info(`[ATH Backfill] 📊 Avg OHLCV Fetch: ${avgOhlcvTime}ms`);
    logger.info(`[ATH Backfill] 📊 Avg Process Time: ${avgProcessTime}ms`);
    logger.info(`[ATH Backfill] ════════════════════════════════════════════════════════════`);
    
  } catch (error: any) {
    logger.error('[ATH Backfill] Fatal error:', error);
    updateProgress({
      status: 'error',
      endedAt: new Date(),
      lastError: error.message
    });
  }
};

/**
 * Stops/pauses the current backfill.
 */
export const stopAthBackfill = () => {
  if (backfillAbortController) {
    backfillAbortController.abort();
    backfillAbortController = null;
  }
  
  if (backfillState.status === 'running') {
    updateProgress({
      status: 'paused',
      lastError: 'Stopped by user'
    });
  }
};

/**
 * Resets backfill state to idle.
 */
export const resetBackfillState = () => {
  Object.assign(backfillState, {
    status: 'idle',
    phase: 'init',
    totalMints: 0,
    processedMints: 0,
    totalSignals: 0,
    processedSignals: 0,
    currentMint: null,
    currentBatchIndex: 0,
    batchSize: 50,
    startedAt: null,
    updatedAt: null,
    endedAt: null,
    estimatedTimeRemaining: null,
    athUpdatedCount: 0,
    errorCount: 0,
    skippedCount: 0,
    lastError: null,
    ohlcvCallsRemaining: 0,
    ohlcvCallsTotal: 0
  });
};

// ============================================================================
// LIVE ATH REFRESH (Post-Backfill)
// ============================================================================

/**
 * Live ATH refresh using Jupiter batch prices.
 * Runs every 10 seconds to check if any current prices exceed stored ATH.
 * 
 * This is the PRIMARY ATH tracking mechanism after initial backfill:
 * - Fetches current prices via Jupiter batch API (very fast, ~100-500ms for 1000 tokens)
 * - Compares current price to stored ATH
 * - Updates ATH if current price > stored ATH
 * - Also creates initial metrics for signals that don't have any
 */
export const refreshLiveAth = async (options?: {
  onlyNearAth?: boolean; // Only check tokens within 30% of ATH
  maxTokens?: number;
}) => {
  try {
    const start = Date.now();
    
    // Get ALL active signals (including those without metrics)
    const signals = await prisma.signal.findMany({
      where: {
        trackingStatus: { in: ['ACTIVE', 'ENTRY_PENDING'] },
        entryPrice: { not: null, gt: 0 }
      },
      select: {
        id: true,
        mint: true,
        entryPrice: true,
        entrySupply: true,
        entryMarketCap: true,
        entryPriceAt: true,
        detectedAt: true,
        metrics: true
      }
    });
    
    if (signals.length === 0) {
      logger.debug('[Live ATH] No active signals');
      return;
    }
    
    // Separate signals with and without metrics
    const signalsWithMetrics = signals.filter(s => s.metrics);
    const signalsWithoutMetrics = signals.filter(s => !s.metrics);
    
    // Optional: filter to only tokens near ATH
    let signalsToCheck = signalsWithMetrics;
    if (options?.onlyNearAth) {
      signalsToCheck = signalsWithMetrics.filter(s => {
        const athMult = s.metrics?.athMultiple || 1;
        const currMult = s.metrics?.currentMultiple || 0;
        // Within 30% of ATH
        return currMult >= athMult * 0.7;
      });
    }
    
    // Combine with signals without metrics (always check these)
    const allSignalsToCheck = [...signalsToCheck, ...signalsWithoutMetrics];
    
    // Apply max limit if specified
    let finalSignals = allSignalsToCheck;
    if (options?.maxTokens && allSignalsToCheck.length > options.maxTokens) {
      finalSignals = allSignalsToCheck.slice(0, options.maxTokens);
    }
    
    // Get unique mints
    const uniqueMints = [...new Set(finalSignals.map(s => s.mint))];
    
    const dbTime = Date.now() - start;
    logger.debug(`[Live ATH] DB query: ${signals.length} signals (${signalsWithMetrics.length} with metrics, ${signalsWithoutMetrics.length} new) in ${dbTime}ms`);
    
    // Fetch current prices from Jupiter (batch, very fast)
    const jupiterStart = Date.now();
    const priceMap = await getMultipleTokenPrices(uniqueMints);
    const jupiterTime = Date.now() - jupiterStart;
    
    const pricesFound = Object.values(priceMap).filter(p => p && p > 0).length;
    logger.debug(`[Live ATH] Jupiter prices: ${pricesFound}/${uniqueMints.length} in ${jupiterTime}ms`);
    
    // Track updates and creations
    const updates: Array<{ signalId: number; currentPrice: number; newAth: number }> = [];
    const creates: Array<typeof signals[0]> = [];
    
    // Process all signals
    for (const sig of finalSignals) {
      const currentPrice = priceMap[sig.mint];
      if (!currentPrice || currentPrice <= 0) continue;
      
      const entryPrice = sig.entryPrice!;
      
      if (sig.metrics) {
        // Has existing metrics - check if ATH needs update
        const storedAthPrice = sig.metrics.athPrice || entryPrice;
        if (currentPrice > storedAthPrice) {
          updates.push({
            signalId: sig.id,
            currentPrice,
            newAth: currentPrice
          });
        }
      } else {
        // No metrics - need to create them
        creates.push(sig);
      }
    }
    
    const now = new Date();
    
    // Update ATHs for signals that hit new ATH
    if (updates.length > 0) {
      for (const update of updates) {
        const sig = finalSignals.find(s => s.id === update.signalId);
        if (!sig) continue;
        
        const entryPrice = sig.entryPrice!;
        const entrySupply = sig.entrySupply ||
          (sig.entryMarketCap && entryPrice > 0 ? sig.entryMarketCap / entryPrice : null);
        
        const athMultiple = update.newAth / entryPrice;
        const athMarketCap = entrySupply ? update.newAth * entrySupply : null;
        const currentMultiple = update.currentPrice / entryPrice;
        const currentMarketCap = entrySupply ? update.currentPrice * entrySupply : null;
        
        // Calculate time to ATH from entry
        const entryTime = getEntryTime(sig as any);
        const timeToAth = entryTime ? now.getTime() - entryTime.getTime() : 0;
        
        try {
          await prisma.signalMetric.update({
            where: { signalId: update.signalId },
            data: {
              currentPrice: update.currentPrice,
              currentMultiple,
              currentMarketCap,
              athPrice: update.newAth,
              athMultiple,
              athMarketCap,
              athAt: now,
              timeToAth,
              updatedAt: now
            }
          });
        } catch (err) {
          logger.debug(`[Live ATH] Failed to update signal ${update.signalId}: ${err}`);
        }
      }
    }
    
    // Create initial metrics for signals without any
    let metricsCreated = 0;
    if (creates.length > 0) {
      for (const sig of creates) {
        const currentPrice = priceMap[sig.mint];
        if (!currentPrice || currentPrice <= 0) continue;
        
        const entryPrice = sig.entryPrice!;
        const entrySupply = sig.entrySupply ||
          (sig.entryMarketCap && entryPrice > 0 ? sig.entryMarketCap / entryPrice : null);
        
        // ATH is max of entry price and current price
        const athPrice = Math.max(entryPrice, currentPrice);
        const athMultiple = athPrice / entryPrice;
        const athMarketCap = entrySupply ? athPrice * entrySupply : null;
        const currentMultiple = currentPrice / entryPrice;
        const currentMarketCap = entrySupply ? currentPrice * entrySupply : null;
        
        // Time to ATH is 0 if current price is ATH, or null if entry was ATH
        const entryTime = getEntryTime(sig as any);
        const timeToAth = currentPrice >= entryPrice && entryTime
          ? now.getTime() - entryTime.getTime()
          : 0;
        
        try {
          await prisma.signalMetric.create({
            data: {
              signalId: sig.id,
              currentPrice,
              currentMultiple,
              currentMarketCap,
              athPrice,
              athMultiple,
              athMarketCap,
              athAt: now,
              timeToAth,
              maxDrawdown: currentMultiple < 1 ? ((currentMultiple - 1) * 100) : 0, // Negative if below entry
              updatedAt: now
            }
          });
          metricsCreated++;
        } catch (err) {
          // Ignore duplicate errors (concurrent creation)
          logger.debug(`[Live ATH] Failed to create metrics for signal ${sig.id}: ${err}`);
        }
      }
    }
    
    const elapsed = Date.now() - start;
    const summary = [];
    if (updates.length > 0) summary.push(`${updates.length} new ATHs`);
    if (metricsCreated > 0) summary.push(`${metricsCreated} metrics created`);
    
    if (summary.length > 0) {
      logger.info(`[Live ATH] ✅ ${summary.join(', ')} in ${elapsed}ms`);
    } else {
      logger.debug(`[Live ATH] No updates in ${elapsed}ms (checked ${uniqueMints.length} mints)`);
    }
    
  } catch (error: any) {
    logger.error('[Live ATH] Error in refresh:', error);
  }
};

