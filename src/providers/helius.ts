import { createHelius, type HeliusClient } from 'helius-sdk';
import axios from 'axios'; // Still needed for price fallback if SDK doesn't cover it
import { MarketDataProvider, PriceQuote, TokenMeta, OHLCV } from './types';
import { logger } from '../utils/logger';

export class HeliusProvider implements MarketDataProvider {
  private helius: HeliusClient;
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.helius = createHelius({ apiKey, network: 'mainnet' });
  }

  async getQuote(mint: string): Promise<PriceQuote> {
    // Try Jupiter v6 first (public, no auth required)
    try {
      const v6Response = await axios.get(`https://price.jup.ag/v6/price?ids=${mint}`, {
        timeout: 10000,
      });
      
      if (v6Response.data && v6Response.data.data && v6Response.data.data[mint]) {
        return {
          price: v6Response.data.data[mint].price,
          timestamp: Date.now(),
          source: 'helius',
          confidence: 1.0
        };
      }
    } catch (v6Error) {
      logger.warn(`Jupiter v6 failed for ${mint}, trying v2...`, v6Error);
    }

    // Fallback to v2 if v6 fails
    try {
      const v2Response = await axios.get(`https://api.jup.ag/price/v2?ids=${mint}`, {
        timeout: 10000,
      });
      
      if (v2Response.data && v2Response.data.data && v2Response.data.data[mint]) {
        const data = v2Response.data.data[mint];
        return {
          price: parseFloat(data.price),
          timestamp: Date.now(),
          source: 'helius',
          confidence: 1.0,
        };
      }
    } catch (v2Error) {
      logger.warn(`Jupiter v2 also failed for ${mint}`, v2Error);
    }

    throw new Error(`No price data available for ${mint} from Jupiter APIs`);
  }

  async getTokenMeta(mint: string): Promise<TokenMeta> {
    try {
      // Use Helius SDK for Metadata (DAS)
      const response = await this.helius.getAsset({ id: mint });

      if (response) {
        return {
          mint,
          name: response.content?.metadata?.name || 'Unknown',
          symbol: response.content?.metadata?.symbol || 'UNKNOWN',
          decimals: response.token_info?.decimals || 9,
          image: response.content?.links?.image,
        };
      }
      
      throw new Error(`No metadata for ${mint}`);
    } catch (error) {
      logger.error(`Error fetching metadata for ${mint}:`, error);
      // Fallback to basic
      return {
         mint,
         name: 'Unknown',
         symbol: 'UNKNOWN'
      };
    }
  }

  async getOHLCV(mint: string, timeframe: string, start: number, end: number): Promise<OHLCV[] | null> {
    return null;
  }
}
