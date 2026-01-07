import { createHelius, type HeliusClient } from 'helius-sdk';
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
    try {
      // Use Helius SDK getAsset to fetch price data
      const asset = await this.helius.getAsset({ id: mint });

      if (asset?.token_info?.price_info) {
        const priceInfo = asset.token_info.price_info;
        // price_per_token is typically in the currency specified
        const price = priceInfo.price_per_token || 0;
        
        return {
          price: price,
          timestamp: Date.now(),
          source: 'helius',
          confidence: priceInfo.currency ? 1.0 : 0.8, // Lower confidence if no currency info
        };
      }

      // If no price_info, try to get from token accounts or other sources
      // For now, throw error if no price data available
      throw new Error(`No price data available for ${mint} from Helius`);
    } catch (error) {
      logger.error(`Error fetching price for ${mint} from Helius:`, error);
      throw error;
    }
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
