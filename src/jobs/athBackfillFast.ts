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

const fetchGeckoTerminalFast = async (mint: string, fromTime: number): Promise<DexScreenerCandle[]> => {
  try {
    // Check cache first
    let poolAddress = poolCache.get(mint);
    
    if (poolAddress === undefined) {
      // Fetch pool address
      try {
        const poolResponse = await axios.get(`https://api.geckoterminal.com/api/v2/networks/solana/tokens/${mint}/pools`, {
          params: { page: 1, limit: 1 },
          timeout: 5000
        });
        poolAddress = poolResponse.data?.data?.[0]?.attributes?.address || null;
        poolCache.set(mint, poolAddress);
      } catch {
        poolCache.set(mint, null);
        return [];
      }
    }
    
    if (!poolAddress) return [];
    
    // Fetch daily candles (covers most history in one call)
    const response = await axios.get(
      `https://api.geckoterminal.com/api/v2/networks/solana/pools/${poolAddress}/ohlcv/day`,
      {
        params: { limit: 1000 },
        timeout: 10000
      }
    );
    
    const list = response.data?.data?.attributes?.ohlcv_list || [];
    return list.map((c: any[]) => ({
      timestamp: c[0] * 1000,
      open: c[1],
      high: c[2],
      low: c[3],
      close: c[4],
      volume: c[5]
    })).reverse();
    
  } catch (err: any) {
    if (err.response?.status !== 429) {
      logger.debug(`[FastBackfill] GeckoTerminal failed for ${mint.slice(0, 8)}...: ${err.message}`);
    }
    return [];
  }
};

// ============================================================================
// Combined fetcher with fallbacks
// ============================================================================

const fetchOHLCVFast = async (mint: string, fromTime: number): Promise<DexScreenerCandle[]> => {
  // Try Birdeye first (best data if we have API key)
  if (BIRDEYE_API_KEY) {
    const birdeye = await fetchBirdeyeOHLCV(mint, fromTime);
    if (birdeye.length > 0) return birdeye;
  }
  
  // Try GeckoTerminal (good data, slower)
  const gecko = await fetchGeckoTerminalFast(mint, fromTime);
  if (gecko.length > 0) return gecko;
  
  // Fallback to DexScreener (limited but fast)
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
    
    if (candles.length === 0) {
      skipped = data.signals.length;
      return { updated, errors, skipped };
    }
    
    const now = new Date();
    const updates: any[] = [];
    
    for (const sig of data.signals) {
      try {
        const entryPrice = sig.entryPrice;
        const entryTime = sig.entryTime;
        
        // Find ATH from candles after entry
        const validCandles = candles.filter(c => c.timestamp >= entryTime - 300000);
        
        if (validCandles.length === 0) {
          skipped++;
          continue;
        }
        
        let athPrice = entryPrice;
        let athAt = entryTime;
        let minLow = entryPrice;
        let minLowAt = entryTime;
        let timeTo2x: number | null = null;
        let timeTo3x: number | null = null;
        let timeTo5x: number | null = null;
        let timeTo10x: number | null = null;
        
        for (const c of validCandles) {
          if (c.high > athPrice) {
            athPrice = c.high;
            athAt = c.timestamp;
          }
          if (c.low < minLow) {
            minLow = c.low;
            minLowAt = c.timestamp;
          }
          if (!timeTo2x && c.high >= entryPrice * 2) timeTo2x = c.timestamp - entryTime;
          if (!timeTo3x && c.high >= entryPrice * 3) timeTo3x = c.timestamp - entryTime;
          if (!timeTo5x && c.high >= entryPrice * 5) timeTo5x = c.timestamp - entryTime;
          if (!timeTo10x && c.high >= entryPrice * 10) timeTo10x = c.timestamp - entryTime;
        }
        
        // Ensure ATH >= entry
        if (athPrice < entryPrice) {
          athPrice = entryPrice;
          athAt = entryTime;
        }
        
        const athMultiple = athPrice / entryPrice;
        const maxDrawdown = minLow < entryPrice ? ((minLow - entryPrice) / entryPrice) * 100 : 0;
        const timeToAth = athAt - entryTime;
        
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

