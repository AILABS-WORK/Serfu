import { MarketDataProvider, PriceQuote, TokenMeta, OHLCV } from './types';
import { logger } from '../utils/logger';
import { getJupiterPrice } from './jupiter';

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
          price: priceInfo.price_per_token || priceInfo.price || 0,
          timestamp: Date.now(),
          source: 'helius',
          confidence: 1.0,
        };
      }

      // Fallback to Jupiter quote if Helius has no price
      const decimals = asset?.token_info?.decimals || 9;
      const jupPrice = await getJupiterPrice(mint, decimals);
      if (jupPrice.price !== null) {
        return {
          price: jupPrice.price,
          timestamp: Date.now(),
          source: jupPrice.source,
          confidence: 0.8,
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
        const tokenInfo = asset.token_info || {};
        const priceInfo = tokenInfo.price_info || {};
        const content = asset.content || {};
        const links = content.links || {};
        
        // Calculate market cap: price_per_token * adjusted_supply
        // Adjusted supply = supply / 10^decimals
        const price = priceInfo.price_per_token || priceInfo.price || 0;
        const supply = tokenInfo.supply || 0;
        const decimals = tokenInfo.decimals || 9;
        const adjustedSupply = supply / Math.pow(10, decimals);
        const marketCap = price > 0 && adjustedSupply > 0 ? price * adjustedSupply : undefined;
        
        // Get social links
        const socialLinks: any = {};
        if (links.website) socialLinks.website = links.website;
        if (links.twitter) socialLinks.twitter = links.twitter;
        if (links.telegram) socialLinks.telegram = links.telegram;
        if (links.discord) socialLinks.discord = links.discord;
        
        // Get creation date - try multiple sources
        let createdAt: Date | undefined;
        if (asset.creators && asset.creators.length > 0) {
          // Try to get from creator verification date
          const creator = asset.creators[0];
          if (creator.verified_at) {
            createdAt = new Date(creator.verified_at * 1000);
          }
        }
        // Fallback to ownership creation date
        if (!createdAt && asset.ownership?.created_at) {
          createdAt = new Date(asset.ownership.created_at * 1000);
        }
        
        return {
          mint,
          name: content.metadata?.name || 'Unknown',
          symbol: content.metadata?.symbol || 'UNKNOWN',
          decimals: tokenInfo.decimals || 9,
          image: links.image,
          marketCap,
          volume24h: priceInfo.volume_24h,
          liquidity: priceInfo.liquidity,
          supply: adjustedSupply > 0 ? adjustedSupply : undefined,
          priceChange1h: priceInfo.price_change_1h || priceInfo.price_change_24h, // Use 1h if available
          ath: priceInfo.ath_price,
          athDate: priceInfo.ath_price_date ? new Date(priceInfo.ath_price_date * 1000) : undefined,
          socialLinks: Object.keys(socialLinks).length > 0 ? socialLinks : undefined,
          launchpad: asset.creators?.[0]?.address || undefined, // Could be enhanced with launchpad detection
          createdAt,
          chain: 'Solana',
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
        chain: 'Solana',
      };
    }
  }

  async getOHLCV(mint: string, timeframe: string, start: number, end: number): Promise<OHLCV[] | null> {
    return null;
  }
}
