export interface TokenMeta {
  mint: string;
  name: string;
  symbol: string;
  decimals?: number;
  image?: string;
  // Enhanced metadata
  marketCap?: number;
  volume24h?: number;
  liquidity?: number;
  supply?: number;
  priceChange1h?: number;
  ath?: number;
  athDate?: Date;
  socialLinks?: {
    website?: string;
    twitter?: string;
    telegram?: string;
    discord?: string;
  };
  launchpad?: string;
  createdAt?: Date; // Token creation date
  chain?: string;
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



