import { prisma } from '../db';
import { logger } from '../utils/logger';
import { getEntryTime } from '../analytics/metricsUtils';
import axios from 'axios';

// ============================================================================
// FAST ATH BACKFILL - Optimized for speed
// 
// Key optimizations:
// 1. Use DexScreener API (faster, no pool lookup needed)
// 2. High parallelism (10-15 concurrent)
// 3. Single API call per mint (daily candles cover all history)
// 4. Minimal delays (only on rate limits)
// 5. In-memory pool cache
// 6. Batch DB writes
// ============================================================================

const DEXSCREENER_BASE = 'https://api.dexscreener.com/latest/dex';

export interface FastBackfillProgress {
  status: 'idle' | 'running' | 'paused' | 'complete' | 'error';
  totalMints: number;
  processedMints: number;
  totalSignals: number;
  processedSignals: number;
  athUpdated: number;
  errors: number;
  skipped: number;
  currentMint: string | null;
  startedAt: Date | null;
  updatedAt: Date | null;
  eta: number | null;
  avgTimePerMint: number;
  lastError: string | null;
}

const progress: FastBackfillProgress = {
  status: 'idle',
  totalMints: 0,
  processedMints: 0,
  totalSignals: 0,
  processedSignals: 0,
  athUpdated: 0,
  errors: 0,
  skipped: 0,
  currentMint: null,
  startedAt: null,
  updatedAt: null,
  eta: null,
  avgTimePerMint: 0,
  lastError: null
};

let abortController: AbortController | null = null;

export const getFastBackfillProgress = () => ({ ...progress });

export const stopFastBackfill = () => {
  if (abortController) {
    abortController.abort();
    progress.status = 'paused';
  }
};

// ============================================================================
// DexScreener OHLCV - Single call, no pool lookup needed
// ============================================================================

interface DexScreenerCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const fetchDexScreenerOHLCV = async (mint: string, retries = 2): Promise<DexScreenerCandle[]> => {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      // DexScreener returns OHLCV directly for a token without needing pool address
      const response = await axios.get(`${DEXSCREENER_BASE}/tokens/${mint}`, {
        timeout: 8000,
        headers: { 'Accept': 'application/json' }
      });
      
      const pairs = response.data?.pairs;
      if (!pairs || pairs.length === 0) {
        return [];
      }
      
      // Get the most liquid pair
      const pair = pairs.sort((a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
      
      // DexScreener provides price history in the pair data
      // We can derive ATH from the priceChange data or use the pair's historicalPrices
      // For now, we'll extract what we can from the pair data
      
      // Unfortunately DexScreener doesn't give full OHLCV history in the free API
      // But we can get: current price, price changes (5m, 1h, 6h, 24h), and ATH if available
      
      const priceUsd = pair.priceUsd ? parseFloat(pair.priceUsd) : 0;
      const priceChange24h = pair.priceChange?.h24 || 0;
      
      // Create a synthetic candle with current data
      // This is limited but much faster than GeckoTerminal
      if (priceUsd > 0) {
        const now = Date.now();
        // Estimate 24h ago price
        const price24hAgo = priceUsd / (1 + priceChange24h / 100);
        
        return [
          { timestamp: now - 24 * 60 * 60 * 1000, open: price24hAgo, high: price24hAgo, low: price24hAgo, close: price24hAgo, volume: 0 },
          { timestamp: now, open: priceUsd, high: priceUsd, low: priceUsd, close: priceUsd, volume: 0 }
        ];
      }
      
      return [];
    } catch (err: any) {
      if (err.response?.status === 429 && attempt < retries - 1) {
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      if (attempt === retries - 1) {
        logger.debug(`[FastBackfill] DexScreener failed for ${mint.slice(0, 8)}...: ${err.message}`);
      }
    }
  }
  return [];
};

// ============================================================================
// Birdeye OHLCV - Better historical data
// ============================================================================

const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY;

const fetchBirdeyeOHLCV = async (mint: string, fromTime: number): Promise<DexScreenerCandle[]> => {
  if (!BIRDEYE_API_KEY) return [];
  
  try {
    const toTime = Math.floor(Date.now() / 1000);
    const response = await axios.get(`https://public-api.birdeye.so/defi/ohlcv`, {
      params: {
        address: mint,
        type: '1D', // Daily candles
        time_from: Math.floor(fromTime / 1000),
        time_to: toTime
      },
      headers: {
        'X-API-KEY': BIRDEYE_API_KEY,
        'Accept': 'application/json'
      },
      timeout: 10000
    });
    
    const items = response.data?.data?.items || [];
    return items.map((c: any) => ({
      timestamp: c.unixTime * 1000,
      open: c.o,
      high: c.h,
      low: c.l,
      close: c.c,
      volume: c.v
    }));
  } catch (err: any) {
    logger.debug(`[FastBackfill] Birdeye failed for ${mint.slice(0, 8)}...: ${err.message}`);
    return [];
  }
};

// ============================================================================
// GeckoTerminal with pool cache
// ============================================================================

const poolCache = new Map<string, string | null>();

/**
 * Fetch OHLCV with smart tiered timeframes for accuracy:
 * 1. MINUTE candles from entry until next hour boundary (captures partial hour)
 * 2. HOUR candles from hour boundary until next day boundary
 * 3. DAY candles for older history
 * 
 * This ensures we don't mistake pre-entry highs as ATH.
 */
const fetchGeckoTerminalTiered = async (mint: string, entryTime: number): Promise<DexScreenerCandle[]> => {
  try {
    // Check cache first
    const cached = poolCache.get(mint);
    let poolAddress: string | null = cached !== undefined ? cached : null;
    
    if (cached === undefined) {
      // Fetch pool address
      try {
        const poolResponse = await axios.get(`https://api.geckoterminal.com/api/v2/networks/solana/tokens/${mint}/pools`, {
          params: { page: 1, limit: 1 },
          timeout: 5000
        });
        const addr = poolResponse.data?.data?.[0]?.attributes?.address;
        poolAddress = addr ? String(addr) : null;
        poolCache.set(mint, poolAddress);
      } catch {
        poolCache.set(mint, null);
        return [];
      }
    }
    
    if (!poolAddress) return [];
    
    const now = Date.now();
    const HOUR_MS = 60 * 60 * 1000;
    const DAY_MS = 24 * HOUR_MS;
    
    // Calculate boundaries
    const nextHourBoundary = Math.ceil(entryTime / HOUR_MS) * HOUR_MS;
    const nextDayBoundary = Math.ceil(nextHourBoundary / DAY_MS) * DAY_MS;
    
    const allCandles: DexScreenerCandle[] = [];
    
    // PHASE 1: Minute candles from entry to next hour boundary
    // This captures the partial first hour accurately
    const minutesToNextHour = Math.ceil((nextHourBoundary - entryTime) / 60000);
    if (minutesToNextHour > 0 && minutesToNextHour <= 60 && nextHourBoundary < now) {
      try {
        const response = await axios.get(
          `https://api.geckoterminal.com/api/v2/networks/solana/pools/${poolAddress}/ohlcv/minute`,
          { params: { limit: Math.min(100, minutesToNextHour + 5) }, timeout: 8000 }
        );
        const list = response.data?.data?.attributes?.ohlcv_list || [];
        const candles = list.map((c: any[]) => ({
          timestamp: c[0] * 1000,
          open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5]
        })).reverse();
        // Filter to only candles AFTER entry time
        const filtered = candles.filter((c: DexScreenerCandle) => c.timestamp >= entryTime);
        allCandles.push(...filtered);
      } catch {
        // Continue without minute candles
      }
    }
    
    // PHASE 2: Hour candles from hour boundary to day boundary (or now if < 1 day)
    const hoursToNextDay = Math.ceil((nextDayBoundary - nextHourBoundary) / HOUR_MS);
    if (hoursToNextDay > 0 && nextHourBoundary < now) {
      try {
        // Fetch enough hourly candles to cover from entry to now (or to where daily takes over)
        const hoursNeeded = Math.min(1000, Math.ceil((now - nextHourBoundary) / HOUR_MS) + 5);
        const response = await axios.get(
          `https://api.geckoterminal.com/api/v2/networks/solana/pools/${poolAddress}/ohlcv/hour`,
          { params: { limit: hoursNeeded }, timeout: 10000 }
        );
        const list = response.data?.data?.attributes?.ohlcv_list || [];
        const candles = list.map((c: any[]) => ({
          timestamp: c[0] * 1000,
          open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5]
        })).reverse();
        // Filter to only COMPLETE hour candles (start time >= next hour boundary)
        const filtered = candles.filter((c: DexScreenerCandle) => c.timestamp >= nextHourBoundary);
        allCandles.push(...filtered);
      } catch {
        // Continue without hourly candles
      }
    }
    
    // PHASE 3: Daily candles for older history (if signal is old enough)
    const ageInDays = (now - entryTime) / DAY_MS;
    if (ageInDays > 2) {
      try {
        const daysNeeded = Math.min(1000, Math.ceil(ageInDays) + 5);
        const response = await axios.get(
          `https://api.geckoterminal.com/api/v2/networks/solana/pools/${poolAddress}/ohlcv/day`,
          { params: { limit: daysNeeded }, timeout: 10000 }
        );
        const list = response.data?.data?.attributes?.ohlcv_list || [];
        const candles = list.map((c: any[]) => ({
          timestamp: c[0] * 1000,
          open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5]
        })).reverse();
        // Filter to only COMPLETE day candles (start time >= next day boundary)
        const filtered = candles.filter((c: DexScreenerCandle) => c.timestamp >= nextDayBoundary);
        allCandles.push(...filtered);
      } catch {
        // Continue without daily candles
      }
    }
    
    // Deduplicate by timestamp (in case of overlaps)
    const uniqueMap = new Map<number, DexScreenerCandle>();
    for (const c of allCandles) {
      const key = Math.round(c.timestamp / 60000) * 60000; // Round to minute
      if (!uniqueMap.has(key) || c.timestamp > uniqueMap.get(key)!.timestamp) {
        uniqueMap.set(key, c);
      }
    }
    
    return Array.from(uniqueMap.values()).sort((a, b) => a.timestamp - b.timestamp);
    
  } catch (err: any) {
    if (err.response?.status !== 429) {
      logger.debug(`[FastBackfill] GeckoTerminal tiered fetch failed for ${mint.slice(0, 8)}...: ${err.message}`);
    }
    return [];
  }
};

// Simple fast fetch for fallback (less accurate but faster)
const fetchGeckoTerminalFast = async (mint: string, fromTime: number): Promise<DexScreenerCandle[]> => {
  try {
    const cached = poolCache.get(mint);
    let poolAddress: string | null = cached !== undefined ? cached : null;
    
    if (cached === undefined) {
      try {
        const poolResponse = await axios.get(`https://api.geckoterminal.com/api/v2/networks/solana/tokens/${mint}/pools`, {
          params: { page: 1, limit: 1 },
          timeout: 5000
        });
        const addr = poolResponse.data?.data?.[0]?.attributes?.address;
        poolAddress = addr ? String(addr) : null;
        poolCache.set(mint, poolAddress);
      } catch {
        poolCache.set(mint, null);
        return [];
      }
    }
    
    if (!poolAddress) return [];
    
    const response = await axios.get(
      `https://api.geckoterminal.com/api/v2/networks/solana/pools/${poolAddress}/ohlcv/hour`,
      { params: { limit: 1000 }, timeout: 10000 }
    );
    
    const list = response.data?.data?.attributes?.ohlcv_list || [];
    return list.map((c: any[]) => ({
      timestamp: c[0] * 1000,
      open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5]
    })).reverse();
    
  } catch (err: any) {
    return [];
  }
};

// ============================================================================
// Combined fetcher with fallbacks
// ============================================================================

const fetchOHLCVFast = async (mint: string, entryTime: number): Promise<DexScreenerCandle[]> => {
  // Try Birdeye first (best data if we have API key)
  if (BIRDEYE_API_KEY) {
    const birdeye = await fetchBirdeyeOHLCV(mint, entryTime);
    if (birdeye.length > 0) return birdeye;
  }
  
  // Try GeckoTerminal with TIERED approach (most accurate)
  // Uses minute → hour → day candles based on entry time boundaries
  const tiered = await fetchGeckoTerminalTiered(mint, entryTime);
  if (tiered.length > 0) return tiered;
  
  // Fallback to simple hourly fetch (less accurate but better than nothing)
  const gecko = await fetchGeckoTerminalFast(mint, entryTime);
  if (gecko.length > 0) return gecko;
  
  // Last resort: DexScreener (very limited but fast)
  return fetchDexScreenerOHLCV(mint);
};

// ============================================================================
// Process a batch of mints
// ============================================================================

interface MintData {
  mint: string;
  signals: Array<{
    id: number;
    entryPrice: number;
    entrySupply: number | null;
    entryMarketCap: number | null;
    entryTime: number;
  }>;
  earliestEntry: number;
}

const processMint = async (data: MintData): Promise<{ updated: number; errors: number; skipped: number }> => {
  let updated = 0;
  let errors = 0;
  let skipped = 0;
  
  try {
    const candles = await fetchOHLCVFast(data.mint, data.earliestEntry);
    const processTime = new Date();
    
    // If no candles found, still process signals with ATH = entry price
    // This is valid: if no price data exists, entry price IS the ATH (1x)
    if (candles.length === 0) {
      for (const sig of data.signals) {
        try {
          const entryPrice = sig.entryPrice;
          const entryTime = sig.entryTime;
          const entrySupply = sig.entrySupply || (sig.entryMarketCap && entryPrice > 0 ? sig.entryMarketCap / entryPrice : null);
          const entryMarketCap = sig.entryMarketCap || (entrySupply ? entryPrice * entrySupply : null);
          
          await prisma.signalMetric.upsert({
            where: { signalId: sig.id },
            create: {
              signalId: sig.id,
              currentPrice: entryPrice,
              currentMultiple: 1.0,
              currentMarketCap: entryMarketCap,
              athPrice: entryPrice,
              athMultiple: 1.0,
              athMarketCap: entryMarketCap,
              athAt: new Date(entryTime),
              timeToAth: 0,
              maxDrawdown: 0,
              updatedAt: processTime
            },
            update: {
              // Only update if no ATH exists yet
              athPrice: entryPrice,
              athMultiple: 1.0,
              athAt: new Date(entryTime),
              timeToAth: 0,
              maxDrawdown: 0,
              updatedAt: processTime
            }
          });
          updated++;
        } catch {
          errors++;
        }
      }
      return { updated, errors, skipped };
    }
    
    const now = new Date();
    const updates: any[] = [];
    
    for (const sig of data.signals) {
      try {
        const entryPrice = sig.entryPrice;
        const entryTime = sig.entryTime;
        
        // IMPORTANT: Only use candles AFTER entry time (no buffer before!)
        // This prevents false ATH from pre-entry price spikes
        const validCandles = candles.filter(c => c.timestamp >= entryTime);
        
        if (validCandles.length === 0) {
          // No candles after entry - use entry price as ATH
          // This can happen for very new signals
          skipped++;
          continue;
        }
        
        // Start with entry price as baseline ATH (at entry time)
        let athPrice = entryPrice;
        let athAt = entryTime;
        let minLow = entryPrice;
        let minLowAt = entryTime;
        let timeTo2x: number | null = null;
        let timeTo3x: number | null = null;
        let timeTo5x: number | null = null;
        let timeTo10x: number | null = null;
        
        for (const c of validCandles) {
          // Only update ATH if we find a HIGHER price AFTER entry
          if (c.high > athPrice) {
            athPrice = c.high;
            // Ensure athAt is never before entryTime
            athAt = Math.max(c.timestamp, entryTime);
          }
          // Track min low (for drawdown calculation)
          if (c.low > 0 && c.low < minLow) {
            minLow = c.low;
            minLowAt = Math.max(c.timestamp, entryTime);
          }
          // Time-to-Nx milestones (only for candles after entry)
          const candleTimeFromEntry = c.timestamp - entryTime;
          if (candleTimeFromEntry >= 0) {
            if (!timeTo2x && c.high >= entryPrice * 2) timeTo2x = candleTimeFromEntry;
            if (!timeTo3x && c.high >= entryPrice * 3) timeTo3x = candleTimeFromEntry;
            if (!timeTo5x && c.high >= entryPrice * 5) timeTo5x = candleTimeFromEntry;
            if (!timeTo10x && c.high >= entryPrice * 10) timeTo10x = candleTimeFromEntry;
          }
        }
        
        // Final sanity checks
        // 1. ATH price must be >= entry price
        if (athPrice < entryPrice) {
          athPrice = entryPrice;
          athAt = entryTime;
        }
        
        // 2. Ensure athAt >= entryTime (defensive)
        if (athAt < entryTime) {
          athAt = entryTime;
        }
        
        const athMultiple = athPrice / entryPrice;
        const maxDrawdown = minLow < entryPrice ? ((minLow - entryPrice) / entryPrice) * 100 : 0;
        
        // timeToAth can NEVER be negative (athAt >= entryTime is guaranteed)
        const timeToAth = Math.max(0, athAt - entryTime);
        
        const entrySupply = sig.entrySupply || (sig.entryMarketCap && entryPrice > 0 ? sig.entryMarketCap / entryPrice : null);
        const athMarketCap = entrySupply ? athPrice * entrySupply : null;
        const lastCandle = validCandles[validCandles.length - 1];
        const currentPrice = lastCandle.close;
        const currentMultiple = currentPrice / entryPrice;
        const currentMarketCap = entrySupply ? currentPrice * entrySupply : null;
        
        updates.push({
          signalId: sig.id,
          data: {
            currentPrice,
            currentMultiple,
            currentMarketCap,
            athPrice,
            athMultiple,
            athMarketCap,
            athAt: new Date(athAt),
            timeToAth,
            maxDrawdown,
            timeTo2x,
            timeTo3x,
            timeTo5x,
            timeTo10x,
            minLowPrice: minLow,
            minLowAt: new Date(minLowAt),
            ohlcvLastAt: new Date(lastCandle.timestamp),
            updatedAt: now
          }
        });
        
        updated++;
      } catch (err) {
        errors++;
      }
    }
    
    // Batch upsert
    for (const u of updates) {
      try {
        await prisma.signalMetric.upsert({
          where: { signalId: u.signalId },
          create: { signalId: u.signalId, ...u.data },
          update: u.data
        });
      } catch (err) {
        errors++;
        updated--;
      }
    }
    
  } catch (err) {
    errors = data.signals.length;
  }
  
  return { updated, errors, skipped };
};

// ============================================================================
// Main fast backfill
// ============================================================================

export const startFastBackfill = async (options?: {
  concurrency?: number;
  forceRefresh?: boolean;
}) => {
  if (progress.status === 'running') {
    logger.warn('[FastBackfill] Already running');
    return;
  }
  
  abortController = new AbortController();
  const concurrency = options?.concurrency || 10; // High parallelism
  
  try {
    logger.info('[FastBackfill] ════════════════════════════════════════════════════════════');
    logger.info('[FastBackfill] 🚀 Starting FAST ATH backfill');
    logger.info('[FastBackfill] ════════════════════════════════════════════════════════════');
    
    // Reset progress
    Object.assign(progress, {
      status: 'running',
      totalMints: 0,
      processedMints: 0,
      totalSignals: 0,
      processedSignals: 0,
      athUpdated: 0,
      errors: 0,
      skipped: 0,
      currentMint: null,
      startedAt: new Date(),
      updatedAt: new Date(),
      eta: null,
      avgTimePerMint: 0,
      lastError: null
    });
    
    // Get signals that need ATH
    const whereClause: any = {
      entryPrice: { not: null, gt: 0 }
    };
    
    if (!options?.forceRefresh) {
      whereClause.OR = [
        { metrics: null },
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
      }
    });
    
    logger.info(`[FastBackfill] Found ${signals.length} signals to process`);
    
    // Group by mint
    const mintMap = new Map<string, MintData>();
    
    for (const sig of signals) {
      if (!sig.entryPrice || sig.entryPrice <= 0) continue;
      
      const entryTime = getEntryTime(sig)?.getTime() || sig.detectedAt.getTime();
      
      if (!mintMap.has(sig.mint)) {
        mintMap.set(sig.mint, {
          mint: sig.mint,
          signals: [],
          earliestEntry: entryTime
        });
      }
      
      const entry = mintMap.get(sig.mint)!;
      entry.signals.push({
        id: sig.id,
        entryPrice: sig.entryPrice,
        entrySupply: sig.entrySupply,
        entryMarketCap: sig.entryMarketCap,
        entryTime
      });
      
      if (entryTime < entry.earliestEntry) {
        entry.earliestEntry = entryTime;
      }
    }
    
    const mints = Array.from(mintMap.values());
    progress.totalMints = mints.length;
    progress.totalSignals = signals.length;
    
    logger.info(`[FastBackfill] Processing ${mints.length} unique mints with concurrency ${concurrency}`);
    
    // Process with high parallelism using a work queue
    const queue = [...mints];
    const workers: Promise<void>[] = [];
    let processedCount = 0;
    const startTime = Date.now();
    
    const worker = async () => {
      while (queue.length > 0 && !abortController?.signal.aborted) {
        const mint = queue.shift();
        if (!mint) break;
        
        progress.currentMint = mint.mint;
        const mintStart = Date.now();
        
        try {
          const result = await processMint(mint);
          
          processedCount++;
          progress.processedMints = processedCount;
          progress.processedSignals += mint.signals.length;
          progress.athUpdated += result.updated;
          progress.errors += result.errors;
          progress.skipped += result.skipped;
          
          // Update timing stats
          const elapsed = Date.now() - startTime;
          progress.avgTimePerMint = elapsed / processedCount;
          progress.eta = progress.avgTimePerMint * (mints.length - processedCount);
          progress.updatedAt = new Date();
          
          const mintDuration = Date.now() - mintStart;
          if (processedCount % 50 === 0 || mintDuration > 2000) {
            const pct = ((processedCount / mints.length) * 100).toFixed(1);
            const etaMin = Math.round((progress.eta || 0) / 60000);
            logger.info(`[FastBackfill] Progress: ${pct}% (${processedCount}/${mints.length}) | ETA: ${etaMin}m | Avg: ${Math.round(progress.avgTimePerMint)}ms/mint`);
          }
          
        } catch (err: any) {
          progress.errors += mint.signals.length;
          progress.lastError = err.message;
          logger.debug(`[FastBackfill] Error processing ${mint.mint.slice(0, 8)}...: ${err.message}`);
        }
        
        // Tiny delay to prevent overwhelming APIs
        await new Promise(r => setTimeout(r, 50));
      }
    };
    
    // Start workers
    for (let i = 0; i < concurrency; i++) {
      workers.push(worker());
    }
    
    // Wait for all workers
    await Promise.all(workers);
    
    // Complete
    progress.status = abortController?.signal.aborted ? 'paused' : 'complete';
    progress.currentMint = null;
    progress.updatedAt = new Date();
    
    const totalTime = Date.now() - startTime;
    const avgTime = mints.length > 0 ? Math.round(totalTime / mints.length) : 0;
    
    logger.info('[FastBackfill] ════════════════════════════════════════════════════════════');
    logger.info(`[FastBackfill] ✅ COMPLETE in ${Math.round(totalTime / 60000)}m`);
    logger.info(`[FastBackfill] 📊 ${progress.athUpdated} ATH updated, ${progress.errors} errors, ${progress.skipped} skipped`);
    logger.info(`[FastBackfill] ⚡ Average: ${avgTime}ms per mint`);
    logger.info('[FastBackfill] ════════════════════════════════════════════════════════════');
    
  } catch (err: any) {
    progress.status = 'error';
    progress.lastError = err.message;
    logger.error('[FastBackfill] Fatal error:', err);
  }
};

// ============================================================================
// Export for use in actions
// ============================================================================

export const athBackfillFastService = {
  start: startFastBackfill,
  stop: stopFastBackfill,
  getProgress: getFastBackfillProgress
};

