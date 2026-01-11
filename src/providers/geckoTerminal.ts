import axios from 'axios';
import { logger } from '../utils/logger';

const GECKO_BASE_URL = 'https://api.geckoterminal.com/api/v2';
const DEXSCREENER_BASE_URL = 'https://api.dexscreener.com/latest/dex/tokens';

export interface OHLCV {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export class GeckoTerminalProvider {
  /**
   * Fetch OHLCV data for a token on Solana
   * Hybrid approach: GeckoTerminal lookup -> DexScreener lookup -> GeckoTerminal OHLCV
   * @param mint Token mint address
   * @param timeframe 'day', 'hour', 'minute'
   * @param limit Number of candles (max 1000)
   */
  async getOHLCV(mint: string, timeframe: 'day' | 'hour' | 'minute' = 'hour', limit = 100): Promise<OHLCV[]> {
    try {
      let poolAddress = await this.getTopPool(mint);
      
      // Fallback to DexScreener if Gecko lookup fails
      if (!poolAddress) {
        poolAddress = await this.getPoolFromDexScreener(mint);
      }

      if (!poolAddress) return [];

      const url = `${GECKO_BASE_URL}/networks/solana/pools/${poolAddress}/ohlcv/${timeframe}`;
      const response = await axios.get(url, {
        params: { limit }
      });

      // Response format: 
      // { data: { attributes: { ohlcv_list: [[timestamp, open, high, low, close, volume], ...] } } }
      const list = response.data?.data?.attributes?.ohlcv_list;
      
      if (!Array.isArray(list)) return [];

      return list.map((item: any[]) => ({
        timestamp: item[0] * 1000, // API returns seconds
        open: item[1],
        high: item[2],
        low: item[3],
        close: item[4],
        volume: item[5]
      })).reverse(); // Gecko returns newest first, we usually want chronological? 
      // Actually standard is often newest first or oldest first. 
      // Let's return Chronological (Oldest -> Newest) for easier processing logic.
      // Gecko returns [Newest, ..., Oldest]. So reverse() makes it [Oldest, ..., Newest].

    } catch (error) {
      // logger.error(`GeckoTerminal OHLCV error for ${mint}:`, error);
      return [];
    }
  }

  private async getTopPool(mint: string): Promise<string | null> {
    try {
      // Endpoint to get pools for a token: /networks/solana/tokens/{token_address}/pools
      const url = `${GECKO_BASE_URL}/networks/solana/tokens/${mint}/pools`;
      const response = await axios.get(url, {
        params: { page: 1, limit: 1 } // Get top 1 pool
      });

      const pools = response.data?.data;
      if (pools && pools.length > 0) {
        return pools[0].attributes.address;
      }
      return null;
    } catch (error) {
      return null;
    }
  }

  private async getPoolFromDexScreener(mint: string): Promise<string | null> {
    try {
      const url = `${DEXSCREENER_BASE_URL}/${mint}`;
      const response = await axios.get(url);
      const pairs = response.data?.pairs;
      
      if (pairs && pairs.length > 0) {
        // Return the address of the most liquid pair
        return pairs[0].pairAddress;
      }
      return null;
    } catch (error) {
      return null;
    }
  }
}

export const geckoTerminal = new GeckoTerminalProvider();
