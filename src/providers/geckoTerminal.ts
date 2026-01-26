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
    const overallStart = Date.now();
    
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        // Add delay between retries to avoid rate limits
        if (attempt > 0) {
          // Longer delays for rate limits: 10s, 20s, 30s (increased from 5s, 10s, 15s)
          const delay = Math.min(10000 + (attempt - 1) * 10000, 30000);
          logger.warn(`[GeckoTerminal] Rate limited for ${mint.slice(0, 8)}... (attempt ${attempt + 1}/${retries}), waiting ${delay/1000}s`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
        
        const poolStart = Date.now();
        let poolAddress = await this.getTopPool(mint);
        const poolDuration = Date.now() - poolStart;
        
        // Fallback to DexScreener if Gecko lookup fails
        let dexScreenerDuration = 0;
        if (!poolAddress) {
          const dexStart = Date.now();
          poolAddress = await this.getPoolFromDexScreener(mint);
          dexScreenerDuration = Date.now() - dexStart;
        }

        if (!poolAddress) {
          const totalDuration = Date.now() - overallStart;
          logger.debug(`[GeckoTerminal] No pool for ${mint.slice(0, 8)}... (pool: ${poolDuration}ms, dex: ${dexScreenerDuration}ms, total: ${totalDuration}ms)`);
          return [];
        }

        const ohlcvStart = Date.now();
        const url = `${GECKO_BASE_URL}/networks/solana/pools/${poolAddress}/ohlcv/${timeframe}`;
        const response = await axios.get(url, {
          params: { limit },
          timeout: 15000, // 15 second timeout (increased from 10s)
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'Serfu/1.0'
          }
        });
        const ohlcvDuration = Date.now() - ohlcvStart;

        // Check for rate limit response
        if (response.status === 429) {
          const retryAfter = parseInt(response.headers['retry-after'] || '10', 10);
          const waitTime = Math.max(retryAfter, 10); // Minimum 10 seconds
          logger.warn(`[GeckoTerminal] Rate limited for ${mint.slice(0, 8)}..., waiting ${waitTime}s`);
          if (attempt < retries - 1) {
            await new Promise(resolve => setTimeout(resolve, waitTime * 1000));
            continue; // Retry after rate limit delay
          }
          throw new Error(`Rate limited after ${retries} attempts`);
        }

        // Response format: 
        // { data: { attributes: { ohlcv_list: [[timestamp, open, high, low, close, volume], ...] } } }
        const list = response.data?.data?.attributes?.ohlcv_list;
        
        if (!Array.isArray(list)) {
          const totalDuration = Date.now() - overallStart;
          logger.debug(`[GeckoTerminal] Invalid response for ${mint.slice(0, 8)}... (pool: ${poolDuration}ms, ohlcv: ${ohlcvDuration}ms, total: ${totalDuration}ms)`);
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
        
        const totalDuration = Date.now() - overallStart;
        if (candles.length > 0) {
          logger.debug(`[GeckoTerminal] ✓ ${mint.slice(0, 8)}...: ${candles.length} ${timeframe} candles (pool: ${poolDuration}ms, ohlcv: ${ohlcvDuration}ms, total: ${totalDuration}ms)`);
        } else {
          logger.debug(`[GeckoTerminal] ⚠️ ${mint.slice(0, 8)}...: 0 candles (pool: ${poolDuration}ms, ohlcv: ${ohlcvDuration}ms, total: ${totalDuration}ms)`);
        }
        
        return candles;

      } catch (error: any) {
        lastError = error;
        const isRateLimit = error.response?.status === 429 || error.message?.includes('rate limit');
        const isTimeout = error.code === 'ECONNABORTED' || error.message?.includes('timeout');
        
        if (isRateLimit && attempt < retries - 1) {
          const retryAfter = parseInt(error.response?.headers?.['retry-after'] || '15', 10); // Default to 15s if not specified
          const backoffMs = Math.max(retryAfter * 1000, 15000); // Minimum 15s, use retry-after if longer
          logger.warn(`[GeckoTerminal] Rate limited for ${mint.slice(0, 8)}... (attempt ${attempt + 1}/${retries}), waiting ${backoffMs/1000}s`);
          await new Promise(resolve => setTimeout(resolve, backoffMs));
          continue; // Retry
        }
        
        if (isTimeout && attempt < retries - 1) {
          logger.debug(`[GeckoTerminal] Timeout for ${mint.slice(0, 8)}... (attempt ${attempt + 1}/${retries}), retrying...`);
          continue; // Retry
        }
        
        // Log error on final attempt
        if (attempt === retries - 1) {
          const totalDuration = Date.now() - overallStart;
          logger.error(`[GeckoTerminal] OHLCV error for ${mint.slice(0, 8)}... after ${retries} attempts in ${totalDuration}ms:`, error.response?.status || error.message || error);
        }
      }
    }
    
    // All retries failed
    const totalDuration = Date.now() - overallStart;
    logger.error(`[GeckoTerminal] OHLCV failed for ${mint.slice(0, 8)}... after ${retries} attempts in ${totalDuration}ms:`, lastError?.message || lastError);
    return [];
  }

  private async getTopPool(mint: string, retries = 2): Promise<string | null> {
    let lastError: any = null;
    const start = Date.now();
    
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
            logger.debug(`[GeckoTerminal] Pool lookup rate limited for ${mint.slice(0, 8)}..., waiting ${retryAfter}s`);
            await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
            continue;
          }
        }

        const pools = response.data?.data;
        const duration = Date.now() - start;
        if (pools && pools.length > 0) {
          logger.debug(`[GeckoTerminal] Pool found for ${mint.slice(0, 8)}...: ${pools[0].attributes.address.slice(0, 8)}... in ${duration}ms`);
          return pools[0].attributes.address;
        }
        logger.debug(`[GeckoTerminal] No pools found for ${mint.slice(0, 8)}... in ${duration}ms`);
        return null;
      } catch (error: any) {
        lastError = error;
        if (error.response?.status === 429 && attempt < retries - 1) {
          const retryAfter = parseInt(error.response?.headers?.['retry-after'] || '2', 10);
          logger.debug(`[GeckoTerminal] Pool lookup rate limited for ${mint.slice(0, 8)}..., waiting ${retryAfter}s`);
          await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
          continue;
        }
        if (attempt === retries - 1) {
          const duration = Date.now() - start;
          logger.debug(`[GeckoTerminal] Pool lookup failed for ${mint.slice(0, 8)}... in ${duration}ms:`, error.response?.status || error.message);
        }
      }
    }
    return null;
  }

  private async getPoolFromDexScreener(mint: string): Promise<string | null> {
    const start = Date.now();
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
      const duration = Date.now() - start;
      
      if (pairs && pairs.length > 0) {
        // Return the address of the most liquid pair (sort by liquidity if available)
        const sortedPairs = pairs.sort((a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
        const poolAddress = sortedPairs[0].pairAddress || sortedPairs[0].address;
        if (poolAddress) {
          logger.debug(`[DexScreener] Pool found for ${mint.slice(0, 8)}...: ${poolAddress.slice(0, 8)}... in ${duration}ms`);
          return poolAddress;
        }
        return sortedPairs[0].pairAddress || null;
      }
      logger.debug(`[DexScreener] No pools found for ${mint.slice(0, 8)}... in ${duration}ms`);
      return null;
    } catch (error: any) {
      const duration = Date.now() - start;
      logger.debug(`[DexScreener] Lookup failed for ${mint.slice(0, 8)}... in ${duration}ms:`, error.message || error);
      return null;
    }
  }
}

export const geckoTerminal = new GeckoTerminalProvider();
