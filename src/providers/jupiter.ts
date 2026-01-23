import fetch from 'node-fetch';
import { logger } from '../utils/logger';
import { StatsWindow } from './types';

const JUP_URL = 'https://quote-api.jup.ag/v6/quote';
const JUP_PRICE_URL = 'https://api.jup.ag/price/v3';
const JUP_SEARCH_URL = 'https://api.jup.ag/tokens/v2/search';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const JUP_API_KEY = (process.env.JUPITER_API_KEY || process.env.JUP_API_KEY || '').trim() || undefined;

/**
 * Fetch multiple prices via Jupiter price/v3 (batch request).
 * MAXIMUM SPEED: Process all chunks in parallel with NO delays.
 * Price/v3 supports comma-separated IDs for true batch requests.
 */
export const getMultipleTokenPrices = async (mints: string[]): Promise<Record<string, number | null>> => {
  if (mints.length === 0) return {};
  
  try {
    // Jupiter price/v3 supports batch requests with comma-separated IDs
    // Based on API docs, test with reasonable chunk sizes
    // Start conservative, can increase if no rate limits
    const CHUNK_SIZE = 50; // Start with 50 tokens per request (can test higher)
    const REQUEST_TIMEOUT_MS = 20000; // 20 seconds per request
    const MAX_PARALLEL_CHUNKS = 5; // Process up to 5 chunks in parallel (start conservative)
    
    const chunks = [];
    for (let i = 0; i < mints.length; i += CHUNK_SIZE) {
        chunks.push(mints.slice(i, i + CHUNK_SIZE));
    }

    const results: Record<string, number | null> = {};

    logger.info(`[Jupiter] Fetching prices for ${mints.length} tokens in ${chunks.length} chunks (${CHUNK_SIZE} per chunk, ${MAX_PARALLEL_CHUNKS} parallel)`);

    // Process chunks in parallel batches for maximum speed
    for (let i = 0; i < chunks.length; i += MAX_PARALLEL_CHUNKS) {
      const parallelBatch = chunks.slice(i, i + MAX_PARALLEL_CHUNKS);
      
      await Promise.allSettled(parallelBatch.map(async (chunk, batchIndex) => {
        const chunkIndex = i + batchIndex;
        try {
          const ids = chunk.join(',');
          const headers: Record<string, string> = {};
          if (JUP_API_KEY) {
            headers['x-api-key'] = JUP_API_KEY;
          }
          const url = `${JUP_PRICE_URL}?ids=${ids}`;
          
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
          
          try {
            const res = await fetch(url, { headers, signal: controller.signal });
            clearTimeout(timeoutId);
            
            if (!res.ok) {
              if (res.status === 429) {
                logger.warn(`[Jupiter] Rate limited for chunk ${chunkIndex + 1}/${chunks.length}`);
                // On rate limit, mark as null but continue
              }
              chunk.forEach(mint => {
                if (!(mint in results)) results[mint] = null;
              });
              return;
            }
            
            const data: any = await res.json();
            
            // Jupiter price/v3 response structure: { "mint1": { usdPrice: ... }, "mint2": { usdPrice: ... } }
            // No nested "data" object - tokens are direct keys in the response
            let pricesFound = 0;
            chunk.forEach(mint => {
                const tokenData = data?.[mint];
                const price = tokenData?.usdPrice; // Field is "usdPrice", not "price"
                if (price !== undefined && price !== null && !isNaN(Number(price))) {
                  results[mint] = Number(price);
                  pricesFound++;
                } else {
                  results[mint] = null;
                }
            });
            
            logger.debug(`[Jupiter] Chunk ${chunkIndex + 1}/${chunks.length}: ${pricesFound}/${chunk.length} prices found`);
            
            // Log sample response structure for debugging
            if (chunkIndex === 0 && Object.keys(data || {}).length > 0) {
              const sampleMint = Object.keys(data)[0];
              logger.debug(`[Jupiter] Sample response structure for ${sampleMint.slice(0, 8)}...:`, JSON.stringify(data[sampleMint]).slice(0, 200));
            }
            
          } catch (fetchErr: any) {
            clearTimeout(timeoutId);
            if (fetchErr.name !== 'AbortError') {
              logger.debug(`[Jupiter] Chunk ${chunkIndex + 1} error:`, fetchErr.message || fetchErr);
            }
            chunk.forEach(mint => {
              if (!(mint in results)) results[mint] = null;
            });
          }
        } catch (err: any) {
          logger.debug(`[Jupiter] Error processing chunk ${chunkIndex + 1}:`, err.message || err);
          chunk.forEach(mint => {
            if (!(mint in results)) results[mint] = null;
          });
        }
      }));
    }
    
    const totalPricesFound = Object.values(results).filter(p => p !== null && p > 0).length;
    logger.info(`[Jupiter] Price fetch complete: ${totalPricesFound}/${mints.length} prices found`);

    return results;

  } catch (err: any) {
    logger.error('[Jupiter] Batch price error:', err);
    return {};
  }
};

/**
 * Fetch single price via Jupiter price/v3 API.
 */
const getJupiterPriceV3 = async (mint: string): Promise<{ price: number | null; error?: string }> => {
  try {
    const headers: Record<string, string> = {};
    if (JUP_API_KEY) {
      headers['x-api-key'] = JUP_API_KEY;
    }
    const url = `${JUP_PRICE_URL}?ids=${mint}`;
    const res = await fetch(url, { headers });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.debug(`Jupiter price/v3 failed status ${res.status} body: ${text?.slice(0, 200)}`);
      return { price: null, error: `status ${res.status} body ${text?.slice(0, 200)}` };
    }
    const data: any = await res.json();
    // Response structure: { "mint": { usdPrice: ... } }
    const price = data?.[mint]?.usdPrice;
    if (price === undefined || price === null) return { price: null, error: 'no price in response' };
    return { price: Number(price) };
  } catch (err: any) {
    logger.debug('Jupiter price/v3 error:', err);
    return { price: null, error: err?.message || 'unknown error' };
  }
};

/**
 * Fetch price via Jupiter by quoting 1 SOL to the target mint (fallback if price/v3 unavailable).
 * Assumes decimals if provided; otherwise defaults to 9.
 */
export const getJupiterPrice = async (mint: string, decimals: number = 9): Promise<{ price: number | null; source: string; error?: string }> => {
  try {
    // First try price/v3
    const v3 = await getJupiterPriceV3(mint);
    if (v3.price !== null) return { price: v3.price, source: 'jup_price_v3' };

    const amount = 1_000_000_000; // 1 SOL in lamports
    const url = `${JUP_URL}?inputMint=${SOL_MINT}&outputMint=${mint}&amount=${amount}`;
    const headers: Record<string, string> = {};
    if (JUP_API_KEY) {
      headers['x-api-key'] = JUP_API_KEY;
    }
    const res = await fetch(url, { headers });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.debug(`Jupiter quote failed status ${res.status} body: ${text?.slice(0, 200)}`);
      return { price: null, source: 'jup_quote', error: `status ${res.status} body ${text?.slice(0, 200)}` };
    }
    const data: any = await res.json();
    const outAmount = data?.outAmount;
    if (!outAmount) return { price: null, source: 'jup_quote', error: 'no outAmount in response' };
    const price = Number(outAmount) / Math.pow(10, decimals); // price per 1 SOL
    return { price, source: 'jup_quote' };
  } catch (err: any) {
    logger.debug('Jupiter quote error:', err);
    return { price: null, source: 'jup_quote', error: err?.message || 'unknown error' };
  }
};

export interface JupiterTokenInfo {
  id: string;
  name?: string;
  symbol?: string;
  icon?: string;
  decimals?: number;
  circSupply?: number;
  totalSupply?: number;
  usdPrice?: number;
  mcap?: number;
  fdv?: number;
  liquidity?: number;
  holderCount?: number;
  priceBlockId?: number;
  stats5m?: StatsWindow;
  stats1h?: StatsWindow;
  stats6h?: StatsWindow;
  stats24h?: StatsWindow;
  twitter?: string;
  telegram?: string;
  website?: string;
  launchpad?: string;
  createdAt?: string;
  firstPoolId?: string;
  firstPoolCreatedAt?: string;
  audit?: {
    isSus?: boolean;
    mintAuthorityDisabled?: boolean;
    freezeAuthorityDisabled?: boolean;
    topHoldersPercentage?: number;
    devBalancePercentage?: number;
    devMigrations?: number;
  };
  organicScore?: number;
  organicScoreLabel?: string;
  isVerified?: boolean;
  cexes?: string[];
  tags?: string[];
  graduatedPool?: string;
  graduatedAt?: string;
}

/**
 * Fetch multiple token info via Jupiter search endpoint (batch).
 * This is FASTER than price endpoint because it returns ALL data in one call:
 * price, market cap, liquidity, holders, audit, stats, socials, etc.
 * 
 * Note: Search endpoint queries by mint address, returns array of matches.
 * We process in parallel batches with rate limiting.
 */
export const getMultipleTokenInfo = async (mints: string[]): Promise<Record<string, JupiterTokenInfo | null>> => {
  if (mints.length === 0) return {};
  
  const results: Record<string, JupiterTokenInfo | null> = {};
  
  // Initialize all as null
  mints.forEach(mint => {
    results[mint] = null;
  });
  
  try {
    // OPTIMIZE: Keep high parallelism, handle rate limits with longer waits
    // When rate limited, wait longer and retry instead of reducing parallelism
    const MAX_PARALLEL = 12; // Keep high parallelism for speed
    const REQUEST_TIMEOUT_MS = 15000; // 15 seconds per request
    const DELAY_BETWEEN_BATCHES_MS = 200; // Small delay between batches (200ms)
    const MAX_RETRIES = 3; // More retries for rate-limited requests
    const RATE_LIMIT_WAIT_MS = 3000; // Wait 3 seconds when rate limited
    let rateLimitCount = 0; // Track rate limits for logging
    
    logger.info(`[Jupiter] Fetching token info for ${mints.length} tokens using search endpoint (${MAX_PARALLEL} parallel, ${DELAY_BETWEEN_BATCHES_MS}ms delay between batches)`);
    
    // Process all tokens in parallel batches with adaptive rate limiting
    for (let i = 0; i < mints.length; i += MAX_PARALLEL) {
      const batch = mints.slice(i, i + MAX_PARALLEL);
      const batchNum = Math.floor(i / MAX_PARALLEL) + 1;
      const totalBatches = Math.ceil(mints.length / MAX_PARALLEL);
      
      // Add small delay between batches (except first batch)
      if (i > 0) {
        await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES_MS));
      }
      
      // Process batch in parallel with retry logic
      const batchResults = await Promise.allSettled(batch.map(async (mint) => {
        // Retry logic with exponential backoff
        let retryCount = 0;
        while (retryCount <= MAX_RETRIES) {
          try {
            const headers: Record<string, string> = {};
            if (JUP_API_KEY) {
              headers['x-api-key'] = JUP_API_KEY;
            }
            const url = `${JUP_SEARCH_URL}?query=${mint}`;
            
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
            
            try {
              const res = await fetch(url, { headers, signal: controller.signal });
              clearTimeout(timeoutId);
              
              if (!res.ok) {
                if (res.status === 429) {
                  rateLimitCount++; // Track rate limits for logging
                  // Rate limited - wait longer and retry (don't reduce parallelism)
                  if (retryCount < MAX_RETRIES) {
                    // Check for retry-after header, otherwise use default wait
                    const retryAfter = res.headers.get('retry-after');
                    const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : RATE_LIMIT_WAIT_MS;
                    const backoffMs = Math.min(waitMs + (retryCount * 1000), 8000); // Max 8s wait
                    logger.warn(`[Jupiter] Rate limited for ${mint.slice(0, 8)}... (batch ${batchNum}/${totalBatches}), waiting ${backoffMs}ms (attempt ${retryCount + 1}/${MAX_RETRIES + 1})`);
                    await new Promise(resolve => setTimeout(resolve, backoffMs));
                    retryCount++;
                    continue; // Retry the request
                  } else {
                    logger.warn(`[Jupiter] Rate limited for ${mint.slice(0, 8)}... (batch ${batchNum}/${totalBatches}), max retries reached`);
                    return null;
                  }
                } else {
                  logger.debug(`[Jupiter] Search failed for ${mint.slice(0, 8)}...: ${res.status} ${res.statusText}`);
                  return null;
                }
              }
              
              const data: any = await res.json();
              if (!data || !data.length) {
                logger.warn(`[Jupiter] No results for ${mint.slice(0, 8)}...`);
                return null;
              }
              
              // Search endpoint returns array - find exact match
              const exactMatch = data.find((token: any) => token.id === mint);
              const t = exactMatch || data[0];
              
              // CRITICAL: Log if we found exact match or using first result
              if (!exactMatch && data.length > 0) {
                logger.warn(`[Jupiter] No exact match for ${mint.slice(0, 8)}..., using first result: ${data[0].id?.slice(0, 8)}...`);
              }
              
              // If we have a match (exact or first), use it
              if (t && t.id) {
                // If not exact match, log it
                if (t.id !== mint) {
                  logger.warn(`[Jupiter] Mint mismatch for ${mint.slice(0, 8)}...: got ${t.id?.slice(0, 8)}..., skipping`);
                  return null;
                }
                return { mint, info: {
                  id: t.id,
                  name: t.name,
                  symbol: t.symbol,
                  icon: t.icon,
                  decimals: t.decimals,
                  circSupply: t.circSupply,
                  totalSupply: t.totalSupply,
                  usdPrice: t.usdPrice,
                  mcap: t.mcap,
                  fdv: t.fdv,
                  liquidity: t.liquidity,
                  holderCount: t.holderCount,
                  priceBlockId: t.priceBlockId,
                  stats5m: t.stats5m,
                  stats1h: t.stats1h,
                  stats6h: t.stats6h,
                  stats24h: t.stats24h,
                  twitter: t.twitter,
                  telegram: t.telegram,
                  website: t.website,
                  launchpad: t.launchpad,
                  createdAt: t.createdAt,
                  firstPoolId: t?.firstPool?.id,
                  firstPoolCreatedAt: t?.firstPool?.createdAt,
                  audit: t.audit,
                  organicScore: t.organicScore,
                  organicScoreLabel: t.organicScoreLabel,
                  isVerified: t.isVerified,
                  cexes: t.cexes,
                  tags: t.tags,
                  graduatedPool: t.graduatedPool,
                  graduatedAt: t.graduatedAt,
                }};
              } else {
                logger.debug(`[Jupiter] Mint mismatch for ${mint.slice(0, 8)}...: got ${t.id?.slice(0, 8)}...`);
                return null;
              }
            } catch (fetchErr: any) {
              clearTimeout(timeoutId);
              if (fetchErr.name !== 'AbortError') {
                if (retryCount < MAX_RETRIES) {
                  const backoffMs = Math.pow(2, retryCount) * 1000;
                  await new Promise(resolve => setTimeout(resolve, backoffMs));
                  retryCount++;
                  continue;
                }
                logger.debug(`[Jupiter] Search error for ${mint.slice(0, 8)}...: ${fetchErr.message}`);
              }
              return null;
            }
          } catch (err: any) {
            logger.debug(`[Jupiter] Error processing ${mint.slice(0, 8)}...: ${err.message}`);
            return null;
          }
        }
        return null; // Exhausted retries
      }));
      
      // Store successful results
      batchResults.forEach((result) => {
        if (result.status === 'fulfilled' && result.value) {
          results[result.value.mint] = result.value.info;
        }
      });
      
      const batchSuccessCount = batchResults.filter(r => r.status === 'fulfilled' && r.value).length;
      logger.debug(`[Jupiter] Batch ${batchNum}/${totalBatches} complete: ${batchSuccessCount}/${batch.length} found`);
    }
    
    const found = Object.values(results).filter(r => r !== null).length;
    logger.info(`[Jupiter] Token info fetch complete: ${found}/${mints.length} tokens found`);
    
    return results;
  } catch (err: any) {
    logger.error('[Jupiter] Batch token info error:', err);
    return results;
  }
};

export const getJupiterTokenInfo = async (mint: string): Promise<JupiterTokenInfo | null> => {
  try {
    const headers: Record<string, string> = {};
    if (JUP_API_KEY) {
      headers['x-api-key'] = JUP_API_KEY;
    }
    const url = `${JUP_SEARCH_URL}?query=${mint}`;
    const res = await fetch(url, { headers });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.debug(`Jupiter search failed status ${res.status} body: ${text?.slice(0, 200)}`);
      return null;
    }
    const data: any = await res.json();
    if (!data || !data.length) return null;
    const t = data[0];
    // Verify mint matches
    if (t.id !== mint) return null;
    return {
      id: t.id,
      name: t.name,
      symbol: t.symbol,
      icon: t.icon,
      decimals: t.decimals,
      circSupply: t.circSupply,
      totalSupply: t.totalSupply,
      usdPrice: t.usdPrice,
      mcap: t.mcap,
      fdv: t.fdv,
      liquidity: t.liquidity,
      holderCount: t.holderCount,
      priceBlockId: t.priceBlockId,
      stats5m: t.stats5m,
      stats1h: t.stats1h,
      stats6h: t.stats6h,
      stats24h: t.stats24h,
      twitter: t.twitter,
      telegram: t.telegram,
      website: t.website,
      launchpad: t.launchpad,
      createdAt: t.createdAt,
      firstPoolId: t?.firstPool?.id,
      firstPoolCreatedAt: t?.firstPool?.createdAt,
      audit: t.audit,
      organicScore: t.organicScore,
      organicScoreLabel: t.organicScoreLabel,
      isVerified: t.isVerified,
      cexes: t.cexes,
      tags: t.tags,
      graduatedPool: t.graduatedPool,
      graduatedAt: t.graduatedAt,
    };
  } catch (err: any) {
    logger.debug('Jupiter search error:', err);
    return null;
  }
};
