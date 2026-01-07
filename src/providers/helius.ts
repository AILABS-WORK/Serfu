import { MarketDataProvider, PriceQuote, TokenMeta, OHLCV } from './types';
import { logger } from '../utils/logger';

// Lazy load helius-sdk (ESM module) - use require for type checking
const getHeliusModule = async () => {
  return await import('helius-sdk');
};

export class HeliusProvider implements MarketDataProvider {
  private helius: any;
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    // Initialize helius client lazily
    this.initHelius();
  }

  private async initHelius() {
    try {
      const module = await getHeliusModule();
      this.helius = module.createHelius({ apiKey: this.apiKey, network: 'mainnet' });
    } catch (error) {
      logger.error('Failed to initialize Helius SDK:', error);
    }
  }

  async getQuote(mint: string): Promise<PriceQuote> {
    try {
      // Ensure helius is initialized
      if (!this.helius) {
        await this.initHelius();
      }

      // Use Helius SDK getAsset to fetch price data
      const asset = await this.helius.getAsset({ id: mint });

      if (asset?.token_info?.price_info) {
        const priceInfo = asset.token_info.price_info;
        return {
          price: priceInfo.price || 0,
          timestamp: Date.now(),
          source: 'helius',
          confidence: 1.0,
        };
      }

      throw new Error(`No price data for ${mint}`);
    } catch (error) {
      logger.error(`Error fetching price for ${mint}:`, error);
      throw error;
    }
  }

  async getTokenMeta(mint: string): Promise<TokenMeta> {
    try {
      // Ensure helius is initialized
      if (!this.helius) {
        await this.initHelius();
      }

      // Use Helius SDK for Metadata (DAS)
      const asset = await this.helius.getAsset({ id: mint });

      if (asset) {
        return {
          mint,
          name: asset.content?.metadata?.name || 'Unknown',
          symbol: asset.content?.metadata?.symbol || 'UNKNOWN',
          decimals: asset.token_info?.decimals || 9,
          image: asset.content?.links?.image,
        };
      }

      throw new Error(`No metadata for ${mint}`);
    } catch (error) {
      logger.error(`Error fetching metadata for ${mint}:`, error);
      // Fallback to basic
      return {
        mint,
        name: 'Unknown',
        symbol: 'UNKNOWN',
      };
    }
  }

  async getOHLCV(mint: string, timeframe: string, start: number, end: number): Promise<OHLCV[] | null> {
    return null;
  }
}
