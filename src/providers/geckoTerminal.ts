import axios from 'axios';
import { logger } from '../utils/logger';

const BASE_URL = 'https://api.geckoterminal.com/api/v2';

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
   * @param mint Token mint address
   * @param timeframe 'day', 'hour', 'minute'
   * @param limit Number of candles (max 1000)
   */
  async getOHLCV(mint: string, timeframe: 'day' | 'hour' | 'minute' = 'hour', limit = 100): Promise<OHLCV[]> {
    try {
      // GeckoTerminal uses pool addresses for OHLCV, but also supports token lookups in some endpoints.
      // However, /tokens/{address}/ohlcv is not a standard documented endpoint, usually it's /pools/{address}/ohlcv.
      // We first need to find the top pool for the token.
      
      const poolAddress = await this.getTopPool(mint);
      if (!poolAddress) return [];

      const url = `${BASE_URL}/networks/solana/pools/${poolAddress}/ohlcv/${timeframe}`;
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
      }));

    } catch (error) {
      logger.error(`GeckoTerminal OHLCV error for ${mint}:`, error);
      return [];
    }
  }

  private async getTopPool(mint: string): Promise<string | null> {
    try {
      // Endpoint to get pools for a token: /networks/solana/tokens/{token_address}/pools
      const url = `${BASE_URL}/networks/solana/tokens/${mint}/pools`;
      const response = await axios.get(url, {
        params: { page: 1, limit: 1 } // Get top 1 pool
      });

      const pools = response.data?.data;
      if (pools && pools.length > 0) {
        return pools[0].attributes.address;
      }
      return null;
    } catch (error) {
      // logger.warn(`GeckoTerminal pool lookup failed for ${mint}`);
      return null;
    }
  }
}

export const geckoTerminal = new GeckoTerminalProvider();

