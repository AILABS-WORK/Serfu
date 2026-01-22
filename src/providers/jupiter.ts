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
 * Implements rate limiting with smaller chunks and delays between requests.
 */
export const getMultipleTokenPrices = async (mints: string[]): Promise<Record<string, number | null>> => {
  if (mints.length === 0) return {};
  
  try {
    // Jupiter API rate limits: use smaller chunks (20 tokens) to avoid overwhelming the API
    // Process sequentially with delays to respect rate limits
    const CHUNK_SIZE = 20; // Reduced from 50 to avoid rate limits
    const DELAY_BETWEEN_CHUNKS_MS = 300; // 300ms delay between chunks
    const REQUEST_TIMEOUT_MS = 15000; // 15 seconds per request
    
    const chunks = [];
    for (let i = 0; i < mints.length; i += CHUNK_SIZE) {
        chunks.push(mints.slice(i, i + CHUNK_SIZE));
    }

    const results: Record<string, number | null> = {};
    
    logger.info(`[Jupiter] Fetching prices for ${mints.length} tokens in ${chunks.length} chunks (${CHUNK_SIZE} per chunk)`);

    // Process chunks sequentially with rate limiting
    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        
        // Add delay between chunks (except for the first one)
        if (i > 0) {
          await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_CHUNKS_MS));
        }
        
        try {
          const ids = chunk.join(',');
          const headers: Record<string, string> = {};
          if (JUP_API_KEY) {
            headers['x-api-key'] = JUP_API_KEY;
          }
          const url = `${JUP_PRICE_URL}?ids=${ids}`;
          
          // Add timeout per request
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
          
          try {
            const res = await fetch(url, { headers, signal: controller.signal });
            clearTimeout(timeoutId);
            
            if (!res.ok) {
              const statusText = res.statusText || 'unknown';
              logger.warn(`[Jupiter] Batch price failed for chunk ${i + 1}/${chunks.length}: status ${res.status} (${statusText})`);
              
              // If rate limited (429), add extra delay before continuing
              if (res.status === 429) {
                logger.warn(`[Jupiter] Rate limited, waiting 2 seconds before next chunk`);
                await new Promise(resolve => setTimeout(resolve, 2000));
              }
              
              chunk.forEach(mint => {
                if (!(mint in results)) results[mint] = null;
              });
              continue;
            }
            
            const data: any = await res.json();
            
            let pricesFound = 0;
            chunk.forEach(mint => {
                const price = data?.data?.[mint]?.price;
                if (price !== undefined && price !== null) {
                  results[mint] = Number(price);
                  pricesFound++;
                } else {
                  results[mint] = null;
                }
            });
            
            logger.debug(`[Jupiter] Chunk ${i + 1}/${chunks.length}: ${pricesFound}/${chunk.length} prices found`);
            
          } catch (fetchErr: any) {
            clearTimeout(timeoutId);
            if (fetchErr.name === 'AbortError') {
              logger.warn(`[Jupiter] Batch price timeout for chunk ${i + 1}/${chunks.length} (${chunk.length} tokens)`);
            } else {
              logger.warn(`[Jupiter] Batch price error for chunk ${i + 1}/${chunks.length}:`, fetchErr.message || fetchErr);
            }
            // Mark chunk as missing
            chunk.forEach(mint => {
              if (!(mint in results)) results[mint] = null;
            });
          }
        } catch (err: any) {
          logger.warn(`[Jupiter] Error processing chunk ${i + 1}/${chunks.length}:`, err.message || err);
          // Mark chunk as missing on any error
          chunk.forEach(mint => {
            if (!(mint in results)) results[mint] = null;
          });
        }
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
    const price = data?.data?.[mint]?.price;
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
