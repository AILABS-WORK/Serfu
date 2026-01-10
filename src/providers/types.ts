export interface StatsWindow {
  priceChange?: number;
  holderChange?: number;
  liquidityChange?: number;
  volumeChange?: number;
  buyVolume?: number;
  sellVolume?: number;
  buyOrganicVolume?: number;
  sellOrganicVolume?: number;
  numBuys?: number;
  numSells?: number;
  numTraders?: number;
  numOrganicBuyers?: number;
  numNetBuyers?: number;
}

export interface TokenMeta {
  mint: string;
  name: string;
  symbol: string;
  decimals?: number;
  image?: string;
  // Enhanced metadata
  marketCap?: number;
  fdv?: number;
  volume24h?: number;
  liquidity?: number;
  supply?: number;
  circSupply?: number;
  totalSupply?: number;
  priceChange5m?: number;
  priceChange1h?: number;
  priceChange24h?: number;
  ath?: number;
  athDate?: Date;
  holderCount?: number;
  isVerified?: boolean;
  organicScore?: number;
  organicScoreLabel?: string;
  tags?: string[];
  cexes?: string[];
  stats5m?: StatsWindow;
  stats1h?: StatsWindow;
  stats6h?: StatsWindow;
  stats24h?: StatsWindow;
  audit?: {
    isSus?: boolean;
    mintAuthorityDisabled?: boolean;
    freezeAuthorityDisabled?: boolean;
    topHoldersPercentage?: number;
    devBalancePercentage?: number;
    devMigrations?: number;
  };
  socialLinks?: {
    website?: string;
    twitter?: string;
    telegram?: string;
    discord?: string;
  };
  launchpad?: string;
  createdAt?: Date; // Token creation date
  chain?: string;
  firstPoolId?: string;
  firstPoolCreatedAt?: Date;
  priceBlockId?: number;
  // Live overrides (fresh quote for notifications)
  livePrice?: number | null;
  liveMarketCap?: number | null;
}

export interface PriceQuote {
  price: number;
  timestamp: number; // Unix timestamp in ms
  source: string;
  confidence?: number;
}

export interface OHLCV {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface MarketDataProvider {
  getQuote(mint: string): Promise<PriceQuote>;
  getTokenMeta(mint: string): Promise<TokenMeta>;
  getOHLCV(mint: string, timeframe: string, start: number, end: number): Promise<OHLCV[] | null>;
}



