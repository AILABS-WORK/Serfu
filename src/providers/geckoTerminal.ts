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
  async getOHLCV(mint: string, timeframe: 'day' | 'hour' | 'minute' = 'hour', limit = 100, retries = 3): Promise<OHLCV[]> {
    let lastError: any = null;
    
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        // Add delay between retries to avoid rate limits
        if (attempt > 0) {
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000); // Exponential backoff, max 5s
          await new Promise(resolve => setTimeout(resolve, delay));
        }
        
        let poolAddress = await this.getTopPool(mint);
        
        // Fallback to DexScreener if Gecko lookup fails
        if (!poolAddress) {
          poolAddress = await this.getPoolFromDexScreener(mint);
        }

        if (!poolAddress) {
          logger.debug(`GeckoTerminal: No pool address found for ${mint}`);
          return [];
        }

        const url = `${GECKO_BASE_URL}/networks/solana/pools/${poolAddress}/ohlcv/${timeframe}`;
        const response = await axios.get(url, {
          params: { limit },
          timeout: 10000, // 10 second timeout
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'Serfu/1.0'
          }
        });

        // Check for rate limit response
        if (response.status === 429) {
          const retryAfter = parseInt(response.headers['retry-after'] || '5', 10);
          logger.warn(`GeckoTerminal rate limited for ${mint}, waiting ${retryAfter}s`);
          if (attempt < retries - 1) {
            await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
            continue; // Retry after rate limit delay
          }
          throw new Error(`Rate limited after ${retries} attempts`);
        }

        // Response format: 
        // { data: { attributes: { ohlcv_list: [[timestamp, open, high, low, close, volume], ...] } } }
        const list = response.data?.data?.attributes?.ohlcv_list;
        
        if (!Array.isArray(list)) {
          logger.debug(`GeckoTerminal: Invalid response format for ${mint}`);
          return [];
        }

        const candles = list.map((item: any[]) => ({
          timestamp: item[0] * 1000, // API returns seconds
          open: item[1],
          high: item[2],
          low: item[3],
          close: item[4],
          volume: item[5]
        })).reverse(); // Gecko returns newest first, reverse to chronological
        
        if (candles.length > 0) {
          logger.debug(`GeckoTerminal: Successfully fetched ${candles.length} ${timeframe} candles for ${mint}`);
        }
        
        return candles;

      } catch (error: any) {
        lastError = error;
        const isRateLimit = error.response?.status === 429 || error.message?.includes('rate limit');
        const isTimeout = error.code === 'ECONNABORTED' || error.message?.includes('timeout');
        
        if (isRateLimit && attempt < retries - 1) {
          const retryAfter = parseInt(error.response?.headers?.['retry-after'] || '5', 10);
          logger.warn(`GeckoTerminal rate limited for ${mint} (attempt ${attempt + 1}/${retries}), waiting ${retryAfter}s`);
          await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
          continue; // Retry
        }
        
        if (isTimeout && attempt < retries - 1) {
          logger.debug(`GeckoTerminal timeout for ${mint} (attempt ${attempt + 1}/${retries}), retrying...`);
          continue; // Retry
        }
        
        // Log error on final attempt
        if (attempt === retries - 1) {
          logger.error(`GeckoTerminal OHLCV error for ${mint} after ${retries} attempts:`, error.response?.status || error.message || error);
        }
      }
    }
    
    // All retries failed
    logger.error(`GeckoTerminal OHLCV failed for ${mint} after ${retries} attempts:`, lastError);
    return [];
  }

  private async getTopPool(mint: string, retries = 2): Promise<string | null> {
    let lastError: any = null;
    
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        if (attempt > 0) {
          await new Promise(resolve => setTimeout(resolve, 500 * attempt)); // Small delay between retries
        }
        
        // Endpoint to get pools for a token: /networks/solana/tokens/{token_address}/pools
        const url = `${GECKO_BASE_URL}/networks/solana/tokens/${mint}/pools`;
        const response = await axios.get(url, {
          params: { page: 1, limit: 1 }, // Get top 1 pool
          timeout: 5000,
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'Serfu/1.0'
          }
        });

        // Handle rate limits
        if (response.status === 429) {
          const retryAfter = parseInt(response.headers['retry-after'] || '2', 10);
          if (attempt < retries - 1) {
            await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
            continue;
          }
        }

        const pools = response.data?.data;
        if (pools && pools.length > 0) {
          return pools[0].attributes.address;
        }
        return null;
      } catch (error: any) {
        lastError = error;
        if (error.response?.status === 429 && attempt < retries - 1) {
          const retryAfter = parseInt(error.response?.headers?.['retry-after'] || '2', 10);
          await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
          continue;
        }
        if (attempt === retries - 1) {
          logger.debug(`GeckoTerminal getTopPool failed for ${mint}:`, error.response?.status || error.message);
        }
      }
    }
    return null;
  }

  private async getPoolFromDexScreener(mint: string): Promise<string | null> {
    try {
      const url = `${DEXSCREENER_BASE_URL}/${mint}`;
      const response = await axios.get(url, {
        timeout: 5000,
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Serfu/1.0'
        }
      });
      const pairs = response.data?.pairs;
      
      if (pairs && pairs.length > 0) {
        // Return the address of the most liquid pair (sort by liquidity if available)
        const sortedPairs = pairs.sort((a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
        const poolAddress = sortedPairs[0].pairAddress || sortedPairs[0].address;
        if (poolAddress) {
          logger.debug(`Found DexScreener pool for ${mint}: ${poolAddress}`);
          return poolAddress;
        }
        return sortedPairs[0].pairAddress || null;
      }
      logger.debug(`No DexScreener pairs found for ${mint}`);
      return null;
    } catch (error: any) {
      logger.debug(`DexScreener lookup failed for ${mint}:`, error.message || error);
      return null;
    }
  }
}

export const geckoTerminal = new GeckoTerminalProvider();
