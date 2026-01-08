export interface TokenMeta {
  mint: string;
  name: string;
  symbol: string;
  decimals?: number;
  image?: string;
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


