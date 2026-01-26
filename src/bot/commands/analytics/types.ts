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
  // ATH metrics (populated during live signals view)
  athMult?: number | null;
  maxDrawdown?: number | null;
  timeToAth?: number | null;
}

export interface LiveSignalsCache {
  signals: CachedSignal[];
  fetchedAt: number;
  timeframe: string;
  chain: 'solana' | 'bsc' | 'both';
  timeBasis: 'latest' | 'created';
}

