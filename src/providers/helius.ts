import { MarketDataProvider, PriceQuote, TokenMeta, OHLCV } from './types';
import { logger } from '../utils/logger';
import { getJupiterPrice, getJupiterTokenInfo } from './jupiter';
import { getDexScreenerToken } from './dexscreener';

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
      // Prefer Jupiter search price first for freshness
      const jupInfo = await getJupiterTokenInfo(mint);
      if (jupInfo?.usdPrice !== undefined && jupInfo.usdPrice !== null) {
        return {
          price: jupInfo.usdPrice,
          timestamp: Date.now(),
          source: 'jupiter_search',
          confidence: 0.9,
        };
      }

      // Ensure helius is initialized
      if (!this.helius) {
        await this.initHelius();
      }

      // Use Helius SDK getAsset to fetch price data
      let asset: any = null;
      try {
        asset = await this.helius.getAsset({ id: mint });
      } catch (err) {
        logger.warn(`Helius getAsset failed for ${mint}, falling back to Jupiter:`, err);
      }

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
      if (jupPrice && jupPrice.price !== null) {
        return {
          price: jupPrice.price,
          timestamp: Date.now(),
          source: jupPrice.source,
          confidence: 0.8,
        };
      }

      // Final fallback: DexScreener price
      const ds = await getDexScreenerToken(mint);
      if (ds?.priceUsd !== null && ds?.priceUsd !== undefined) {
        return {
          price: ds.priceUsd,
          timestamp: Date.now(),
          source: 'dexscreener',
          confidence: 0.6,
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
      // Try Jupiter token search first for rich meta and fresh price
      const jupInfo = await getJupiterTokenInfo(mint);
      if (jupInfo) {
        const adjustedSupply = jupInfo.circSupply || jupInfo.totalSupply;
        const marketCap =
          jupInfo.mcap ??
          (jupInfo.usdPrice && adjustedSupply ? jupInfo.usdPrice * adjustedSupply : undefined);
        const volume24h =
          jupInfo.stats24h && (jupInfo.stats24h.buyVolume || jupInfo.stats24h.sellVolume)
            ? (jupInfo.stats24h.buyVolume || 0) + (jupInfo.stats24h.sellVolume || 0)
            : undefined;

        const socialLinks: any = {};
        if (jupInfo.website) socialLinks.website = jupInfo.website;
        if (jupInfo.twitter) socialLinks.twitter = jupInfo.twitter;
        if (jupInfo.telegram) socialLinks.telegram = jupInfo.telegram;

        return {
          mint,
          name: jupInfo.name || 'Unknown',
          symbol: jupInfo.symbol || 'UNKNOWN',
          decimals: jupInfo.decimals || 9,
          image: jupInfo.icon,
          marketCap,
          fdv: jupInfo.fdv,
          liquidity: jupInfo.liquidity,
          supply: adjustedSupply,
          circSupply: jupInfo.circSupply,
          totalSupply: jupInfo.totalSupply,
          priceChange5m: jupInfo.stats5m?.priceChange,
          priceChange1h: jupInfo.stats1h?.priceChange,
          priceChange24h: jupInfo.stats24h?.priceChange,
          stats5m: jupInfo.stats5m,
          stats1h: jupInfo.stats1h,
          stats6h: jupInfo.stats6h,
          stats24h: jupInfo.stats24h,
          volume24h,
          holderCount: jupInfo.holderCount,
          audit: jupInfo.audit,
          organicScore: jupInfo.organicScore,
          organicScoreLabel: jupInfo.organicScoreLabel,
          isVerified: jupInfo.isVerified,
          tags: jupInfo.tags,
          cexes: jupInfo.cexes,
          ath: undefined,
          athDate: undefined,
          socialLinks: Object.keys(socialLinks).length ? socialLinks : undefined,
          launchpad: jupInfo.launchpad,
          createdAt: jupInfo.createdAt ? new Date(jupInfo.createdAt) : undefined,
          firstPoolId: jupInfo.firstPoolId,
          firstPoolCreatedAt: jupInfo.firstPoolCreatedAt ? new Date(jupInfo.firstPoolCreatedAt) : undefined,
          priceBlockId: jupInfo.priceBlockId,
          chain: 'Solana',
          graduatedPool: jupInfo.graduatedPool,
          graduatedAt: jupInfo.graduatedAt ? new Date(jupInfo.graduatedAt) : undefined,
        };
      }

      // Ensure helius is initialized
      if (!this.helius) {
        await this.initHelius();
      }

      // Use Helius SDK for Metadata (DAS)
      let asset: any = null;
      try {
        asset = await this.helius.getAsset({ id: mint });
      } catch (err) {
        logger.warn(`Helius getAsset failed for ${mint}, trying DexScreener:`, err);
      }

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
          priceChange24h: priceInfo.price_change_24h,
          ath: priceInfo.ath_price,
          athDate: priceInfo.ath_price_date ? new Date(priceInfo.ath_price_date * 1000) : undefined,
          socialLinks: Object.keys(socialLinks).length > 0 ? socialLinks : undefined,
          launchpad: asset.creators?.[0]?.address || undefined, // Could be enhanced with launchpad detection
          createdAt,
          chain: 'Solana',
        };
      }

      // Final fallback: DexScreener
      const ds = await getDexScreenerToken(mint);
      if (ds) {
        return {
          mint,
          name: ds.name || 'Unknown',
          symbol: ds.symbol || 'UNKNOWN',
          marketCap: ds.marketCap ?? undefined,
          fdv: ds.fdv ?? undefined,
          liquidity: ds.liquidityUsd ?? undefined,
          volume24h: ds.volume24h ?? undefined,
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

  // --- NEW: Wallet Asset Analysis ---
  async getWalletAssets(ownerAddress: string): Promise<any[]> {
    try {
      if (!this.helius) {
        await this.initHelius();
      }
      
      // Helius SDK v2 exposes RPC methods directly on the rpc property?
      // Or maybe it's just this.helius.getAssetsByOwner?
      // Based on docs, it is helius.rpc.getAssetsByOwner but maybe the object structure is different.
      // Let's try direct call or DAS API specifically if available.
      
      // Attempt 1: Standard RPC method if available
      if (this.helius.rpc?.getAssetsByOwner) {
          const response = await this.helius.rpc.getAssetsByOwner({
            ownerAddress,
            page: 1,
            limit: 100,
            displayOptions: {
              showFungible: true,
              showNativeBalance: true,
            },
          });
          return response.items || [];
      } else {
          // Attempt 2: Maybe DAS is separate? Or fallback to direct fetch?
          // Using fetch if SDK fails
          const response = await fetch(`https://mainnet.helius-rpc.com/?api-key=${this.apiKey}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                  jsonrpc: '2.0',
                  id: 'get-assets',
                  method: 'getAssetsByOwner',
                  params: {
                      ownerAddress,
                      page: 1,
                      limit: 100,
                      displayOptions: {
                          showFungible: true,
                          showNativeBalance: true,
                      }
                  },
              }),
          });
          const data: any = await response.json();
          return data.result?.items || [];
      }
    } catch (error) {
      logger.error(`Error fetching assets for ${ownerAddress}:`, error);
      return [];
    }
  }

  // --- NEW: Transaction History Analysis (Helius Enriched) ---
  async getWalletHistory(address: string, limit: number = 100): Promise<any[]> {
      try {
          if (!this.helius) {
              await this.initHelius();
          }

          let allTransactions: any[] = [];
          let lastSignature: string | undefined = undefined;
          let fetched = 0;

          // Fetch in batches of 100 until limit reached
          while (fetched < limit) {
              const batchLimit = Math.min(100, limit - fetched);
              
              let response: any[] = [];
              
              // Helius v0 API for Enriched Transactions
              // Use direct HTTP fetch to ensure v0 endpoint compatibility as requested
              // Format: https://api-mainnet.helius-rpc.com/v0/addresses/<ADDRESS>/transactions?api-key=<KEY>&type=SWAP
              const url = `https://api-mainnet.helius-rpc.com/v0/addresses/${address}/transactions?api-key=${this.apiKey}&type=SWAP&limit=${batchLimit}${lastSignature ? `&before=${lastSignature}` : ''}`;
              
              const res = await fetch(url);
              if (!res.ok) {
                  logger.warn(`Helius history fetch failed: ${res.status}`);
                  break;
              }
              
              response = await res.json() as any[];

              if (!response || response.length === 0) break;

              allTransactions = [...allTransactions, ...response];
              fetched += response.length;
              lastSignature = response[response.length - 1].signature;

              if (response.length < batchLimit) break; // End of history
          }

          return allTransactions;

      } catch (error) {
          logger.error(`Error fetching history for ${address}:`, error);
          return [];
      }
  }
}
