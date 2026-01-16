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
 */
export const getMultipleTokenPrices = async (mints: string[]): Promise<Record<string, number | null>> => {
  if (mints.length === 0) return {};
  
  try {
    // Jupiter API allows comma separated IDs
    // We should chunk if too many, but 40 is fine usually.
    const chunks = [];
    for (let i = 0; i < mints.length; i += 50) {
        chunks.push(mints.slice(i, i + 50));
    }

    const results: Record<string, number | null> = {};

    for (const chunk of chunks) {
        const ids = chunk.join(',');
        const headers: Record<string, string> = {};
        if (JUP_API_KEY) {
          headers['x-api-key'] = JUP_API_KEY;
        }
        const url = `${JUP_PRICE_URL}?ids=${ids}`;
        const res = await fetch(url, { headers });
        if (!res.ok) {
          logger.debug(`Jupiter batch price failed status ${res.status}`);
          // Mark chunk as missing so we can try fallback later
          chunk.forEach(mint => {
            if (!(mint in results)) results[mint] = null;
          });
          continue;
        }
        const data: any = await res.json();
        
        chunk.forEach(mint => {
            const price = data?.data?.[mint]?.price;
            results[mint] = price !== undefined && price !== null ? Number(price) : null;
        });
    }
    
    // Fallback: use Jupiter search (token info) when batch price returns null
    const missing = Object.entries(results)
      .filter(([, price]) => price === null)
      .map(([mint]) => mint);
    for (const mint of missing) {
      try {
        const info = await getJupiterTokenInfo(mint);
        if (info?.usdPrice !== undefined && info.usdPrice !== null) {
          results[mint] = Number(info.usdPrice);
        }
      } catch (err: any) {
        logger.debug(`Jupiter search fallback failed for ${mint}:`, err);
      }
    }

    return results;

  } catch (err: any) {
    logger.debug('Jupiter batch price error:', err);
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
