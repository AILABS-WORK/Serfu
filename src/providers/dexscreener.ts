import fetch from 'node-fetch';
import { logger } from '../utils/logger';

export interface DexScreenerToken {
  priceUsd: number | null;
  marketCap: number | null;
  fdv: number | null;
  liquidityUsd: number | null;
  volume24h: number | null;
  symbol?: string;
  name?: string;
}

export const getDexScreenerToken = async (mint: string): Promise<DexScreenerToken | null> => {
  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;
    const res = await fetch(url);
    if (!res.ok) {
      logger.debug(`DexScreener token fetch failed status ${res.status}`);
      return null;
    }
    const data: any = await res.json();
    const pair = data?.pairs?.[0];
    if (!pair) return null;
    return {
      priceUsd: pair.priceUsd ? Number(pair.priceUsd) : null,
      marketCap: pair.marketCap ? Number(pair.marketCap) : null,
      fdv: pair.fdv ? Number(pair.fdv) : null,
      liquidityUsd: pair.liquidity?.usd ? Number(pair.liquidity.usd) : null,
      volume24h: pair.volume?.h24 ? Number(pair.volume.h24) : null,
      symbol: pair.baseToken?.symbol,
      name: pair.baseToken?.name,
    };
  } catch (err: any) {
    logger.debug('DexScreener token fetch error:', err);
    return null;
  }
};

