export interface CachedSignal {
  mint: string;
  symbol: string;
  entryPrice: number;
  entryMc: number;
  currentPrice: number;
  currentMc: number;
  pnl: number;
  detectedAt: Date;
  firstDetectedAt: Date;
  groupId: number | null;
  groupName: string;
  userId: number | null;
  userName: string;
  signalId: number;
  hasPrice?: boolean; // True if Jupiter returned a valid price
  hasMc?: boolean; // True if Jupiter returned a valid market cap
}

export interface LiveSignalsCache {
  signals: CachedSignal[];
  fetchedAt: number;
  timeframe: string;
}

