import { prisma } from '../db';
import { Prisma, Signal, SignalMetric } from '../generated/client';

export interface EntityStats {
  id: number;
  name: string;
  totalSignals: number;
  avgMultiple: number; // e.g. 3.5x
  winRate: number; // % of signals > 2x
  winRate5x: number; // % of signals > 5x
  bestCall: {
    mint: string;
    symbol: string;
    multiple: number;
    detectedAt: Date;
  } | null;
  avgDrawdown: number;
  avgTimeToAth: number; // in minutes
  score: number; // Reliability score
  
  // --- New Metrics ---
  consistency: number; // Standard Deviation of ATH Multiples
  rugRate: number; // % of calls with < 0.5x ATH or >90% Drawdown
  mcapAvg: number; // Average Entry Market Cap
  timeToPeak: number; // Avg time to ATH (same as avgTimeToAth, keeping alias)
  sniperScore: number; // % of calls within 10m of token creation (mocked if no creation date)
  consecutiveWins: number; // Current streak of > 2x calls
  followThrough: number; // % of calls that are > 2x
}

type TimeFrame = '7D' | '30D' | 'ALL';

// Type alias for signal with metrics loaded (and optional relations allowed)
type SignalWithMetrics = Signal & { 
  metrics: SignalMetric | null;
  // Allow other relations to pass through
  [key: string]: any; 
};

const getDateFilter = (timeframe: TimeFrame) => {
  const now = new Date();
  if (timeframe === '7D') return new Date(now.setDate(now.getDate() - 7));
  if (timeframe === '30D') return new Date(now.setDate(now.getDate() - 30));
  return new Date(0); // ALL
};

const calculateStats = (signals: SignalWithMetrics[]): EntityStats => {
  if (!signals.length) {
    return {
      id: 0,
      name: '',
      totalSignals: 0,
      avgMultiple: 0,
      winRate: 0,
      winRate5x: 0,
      bestCall: null,
      avgDrawdown: 0,
      avgTimeToAth: 0,
      score: 0,
      consistency: 0,
      rugRate: 0,
      mcapAvg: 0,
      timeToPeak: 0,
      sniperScore: 0,
      consecutiveWins: 0,
      followThrough: 0
    };
  }

  let totalMult = 0;
  let wins = 0;
  let wins5x = 0;
  let totalDrawdown = 0;
  let totalTime = 0; // minutes
  let timeCount = 0;
  let bestSignal: any = null;
  let maxMult = 0;
  
  // New Metrics Accumulators
  let rugCount = 0;
  let totalMcap = 0;
  let mcapCount = 0;
  const multiples: number[] = [];
  let sniperCount = 0; // Calls early
  
  // Sort signals by date for consecutive wins logic
  const sortedSignals = [...signals].sort((a, b) => b.detectedAt.getTime() - a.detectedAt.getTime());
  
  // Calculate Consecutive Wins (Iterate recent to oldest)
  let consecutiveWins = 0;
  for (const s of sortedSignals) {
      const m = s.metrics?.athMultiple || 0;
      if (m > 2) consecutiveWins++;
      else break;
  }

  for (const s of signals) {
    if (!s.metrics) continue;
    
    // Multiple
    const mult = s.metrics.athMultiple || 0;
    multiples.push(mult);
    totalMult += mult;
    if (mult > 2) wins++;
    if (mult > 5) wins5x++;
    if (mult > maxMult) {
      maxMult = mult;
      bestSignal = s;
    }

    // Rug Rate: ATH < 0.5 OR Drawdown < -0.9
    const dd = s.metrics.maxDrawdown || 0;
    if (mult < 0.5 || dd < -0.9) rugCount++;

    // Drawdown (stored as negative decimal e.g. -0.4)
    totalDrawdown += dd;

    // Time to ATH
    if (s.metrics.athAt && s.detectedAt) {
      const diffMs = new Date(s.metrics.athAt).getTime() - new Date(s.detectedAt).getTime();
      if (diffMs > 0) {
        totalTime += diffMs / (1000 * 60); // minutes
        timeCount++;
      }
    }
    
    // Mcap
    if (s.entryMarketCap) {
        totalMcap += s.entryMarketCap;
        mcapCount++;
    }
    
    // Sniper Score: Proxy - if entry supply ~ total supply and low mcap? 
    // Or just check if we caught it very early? 
    // Let's use "Entry MC < 50k" as proxy for "Sniper" or early call for now.
    // Real sniper score needs token creation date.
    if (s.entryMarketCap && s.entryMarketCap < 20000) {
        sniperCount++;
    }
  }

  const count = signals.length;
  const avgMultiple = count ? totalMult / count : 0;
  const winRate = count ? wins / count : 0;
  const winRate5x = count ? wins5x / count : 0;
  const avgDrawdown = count ? totalDrawdown / count : 0; 
  const avgTimeToAth = timeCount ? totalTime / timeCount : 0;
  
  const rugRate = count ? rugCount / count : 0;
  const mcapAvg = mcapCount ? totalMcap / mcapCount : 0;
  const sniperScore = count ? (sniperCount / count) * 100 : 0;
  
  // Consistency (Std Dev)
  let variance = 0;
  if (count > 1) {
      const mean = avgMultiple;
      variance = multiples.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / count;
  }
  const consistency = Math.sqrt(variance); // Standard Deviation. Lower is more consistent? 
  // User wants "Consistency Score". Maybe invert it? Or just show StdDev.
  // Low StdDev = High Consistency.
  
  // Follow Through (Proxy: % > 2x) same as winRate for now
  const followThrough = winRate; 

  // Improved Score Algorithm
  const score = (winRate * 40) + (winRate5x * 20) + (avgMultiple * 5) - (avgDrawdown * 50) - (rugRate * 50);

  return {
    id: 0, // Placeholder
    name: '',
    totalSignals: count,
    avgMultiple,
    winRate,
    winRate5x,
    avgDrawdown,
    avgTimeToAth,
    bestCall: bestSignal ? {
      mint: bestSignal.mint,
      symbol: bestSignal.symbol || 'Unknown',
      multiple: bestSignal.metrics?.athMultiple || 0,
      detectedAt: bestSignal.detectedAt
    } : null,
    score,
    consistency,
    rugRate,
    mcapAvg,
    timeToPeak: avgTimeToAth,
    sniperScore,
    consecutiveWins,
    followThrough
  };
};

// ----------------------------------------------------------------------------
// AGGREGATION HELPERS
// ----------------------------------------------------------------------------

export const getGroupStats = async (groupId: number, timeframe: TimeFrame): Promise<EntityStats | null> => {
  // 1. Get the target group
  const group = await prisma.group.findUnique({ where: { id: groupId } });
  if (!group) return null;

  // 2. Find ALL groups with the same chatId (Deduplication Logic)
  const relatedGroups = await prisma.group.findMany({ 
      where: { chatId: group.chatId },
      select: { id: true } 
  });
  const groupIds = relatedGroups.map(g => g.id);

  const since = getDateFilter(timeframe);
  
  // 3. Fetch Signals from ALL related groups
  // CRITICAL FIX: Do NOT filter by userId. Channels have userId=null.
  // We strictly look for signals linked to these group IDs.
  const signals = await prisma.signal.findMany({
    where: {
      groupId: { in: groupIds },
      detectedAt: { gte: since },
      metrics: { isNot: null }
    },
    include: { metrics: true }
  });

  const stats = calculateStats(signals);
  stats.id = group.id;
  stats.name = group.name || `Group ${group.chatId}`;
  
  return stats;
};

export const getUserStats = async (userId: number, timeframe: TimeFrame): Promise<EntityStats | null> => {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return null;

  const since = getDateFilter(timeframe);
  const signals = await prisma.signal.findMany({
    where: {
      userId,
      detectedAt: { gte: since },
      metrics: { isNot: null }
    },
    include: { metrics: true }
  });

  const stats = calculateStats(signals);
  stats.id = user.id;
  stats.name = user.username || user.firstName || 'Unknown User';

  return stats;
};

export const getLeaderboard = async (
  type: 'GROUP' | 'USER', 
  timeframe: TimeFrame, 
  sortBy: 'PNL' | 'WINRATE' | 'SCORE' = 'SCORE',
  limit = 10
): Promise<EntityStats[]> => {
  const since = getDateFilter(timeframe);
  
  // 1. Fetch all signals in window with metrics
  const signals = await prisma.signal.findMany({
    where: {
      detectedAt: { gte: since },
      metrics: { isNot: null }
    },
    include: { metrics: true, group: true, user: true }
  });

  // 2. Group by Entity (Deduplicating Groups by ChatId)
  const entityMap = new Map<string, typeof signals>();
  const idMap = new Map<string, number>(); // Map Key -> Representative ID
  const nameMap = new Map<string, string>();

  for (const s of signals) {
    let key: string;
    let numericId: number;
    let name: string;

    if (type === 'GROUP') {
        if (!s.group) continue;
        key = s.group.chatId.toString(); // Use ChatID to merge duplicates
        numericId = s.groupId!;
        name = s.group.name || `Group ${s.group.chatId}`;
    } else {
        if (!s.userId) continue;
        key = s.userId.toString();
        numericId = s.userId!;
        name = s.user?.username || s.user?.firstName || 'Unknown';
    }
    
    if (!entityMap.has(key)) {
        entityMap.set(key, []);
        idMap.set(key, numericId);
        nameMap.set(key, name);
    }
    entityMap.get(key)!.push(s);
  }

  // 3. Calculate Stats for each
  const results: EntityStats[] = [];
  for (const [key, entitySignals] of entityMap.entries()) {
    const stats = calculateStats(entitySignals);
    stats.id = idMap.get(key)!;
    stats.name = nameMap.get(key) || 'Unknown';
    // Filter out low volume noise (e.g. need at least 3 calls to rank)
    if (stats.totalSignals >= 3) {
      results.push(stats);
    }
  }

  // 4. Sort
  return results.sort((a, b) => {
    if (sortBy === 'PNL') return b.avgMultiple - a.avgMultiple;
    if (sortBy === 'WINRATE') return b.winRate - a.winRate;
    return b.score - a.score;
  }).slice(0, limit);
};

export const getSignalLeaderboard = async (
  timeframe: TimeFrame, 
  limit = 10
): Promise<Array<{
  id: number, // Add ID
  mint: string,
  symbol: string,
  athMultiple: number,
  sourceName: string,
  detectedAt: Date
}>> => {
  const since = getDateFilter(timeframe);
  
  const signals = await prisma.signal.findMany({
    where: {
      detectedAt: { gte: since },
      metrics: { isNot: null }
    },
    include: { metrics: true, group: true, user: true },
    orderBy: {
        metrics: { athMultiple: 'desc' }
    },
    take: limit
  });

  return signals.map(s => ({
      id: s.id,
      mint: s.mint,
      symbol: s.symbol || 'Unknown',
      athMultiple: s.metrics?.athMultiple || 0,
      sourceName: s.user?.username || s.group?.name || 'Unknown',
      detectedAt: s.detectedAt
  }));
};

export interface DistributionStats {
  winRateBuckets: {
    loss: number;
    x1_2: number;
    x2_3: number;
    x3_5: number;
    x5_10: number;
    x10_plus: number;
  };
  mcBuckets: Array<{
    label: string;
    min: number;
    max: number;
    count: number;
    wins: number; // >2x
    avgMult: number;
  }>;
  totalSignals: number;
}

export const getDistributionStats = async (
  ownerTelegramId: bigint, 
  timeframe: TimeFrame
): Promise<DistributionStats> => {
  const since = getDateFilter(timeframe);
  
  // 1. Get all Groups owned by user (Sources AND Destinations)
  const userGroups = await prisma.group.findMany({
      where: { owner: { userId: ownerTelegramId }, isActive: true },
      select: { id: true, chatId: true, type: true }
  });

  const ownedChatIds = userGroups.map(g => g.chatId);
  const destinationGroupIds = userGroups.filter(g => g.type === 'destination').map(g => g.id);
  
  let forwardedSignalIds: number[] = [];
  if (destinationGroupIds.length > 0) {
      const forwarded = await prisma.forwardedSignal.findMany({
          where: { destGroupId: { in: destinationGroupIds.map(id => BigInt(id)) } },
          select: { signalId: true }
      });
      forwardedSignalIds = forwarded.map(f => f.signalId);
  }

  // 2. Fetch signals
  const signals = await prisma.signal.findMany({
    where: {
      detectedAt: { gte: since },
      metrics: { isNot: null },
      OR: [
          { chatId: { in: ownedChatIds } },
          { id: { in: forwardedSignalIds } }
      ]
    },
    include: { metrics: true }
  });

  // 3. Process Distributions
  const stats: DistributionStats = {
    winRateBuckets: { loss: 0, x1_2: 0, x2_3: 0, x3_5: 0, x5_10: 0, x10_plus: 0 },
    mcBuckets: [
      { label: '< 10k', min: 0, max: 10000, count: 0, wins: 0, avgMult: 0 },
      { label: '10k-20k', min: 10000, max: 20000, count: 0, wins: 0, avgMult: 0 },
      { label: '20k-50k', min: 20000, max: 50000, count: 0, wins: 0, avgMult: 0 },
      { label: '50k-100k', min: 50000, max: 100000, count: 0, wins: 0, avgMult: 0 },
      { label: '100k-250k', min: 100000, max: 250000, count: 0, wins: 0, avgMult: 0 },
      { label: '> 250k', min: 250000, max: 1000000000, count: 0, wins: 0, avgMult: 0 },
    ],
    totalSignals: signals.length
  };

  for (const s of signals) {
    if (!s.metrics) continue;
    const mult = s.metrics.athMultiple || 0;
    const entryMc = s.entryMarketCap || 0;

    // Win Rate Buckets
    if (mult < 1) stats.winRateBuckets.loss++;
    else if (mult < 2) stats.winRateBuckets.x1_2++;
    else if (mult < 3) stats.winRateBuckets.x2_3++;
    else if (mult < 5) stats.winRateBuckets.x3_5++;
    else if (mult < 10) stats.winRateBuckets.x5_10++;
    else stats.winRateBuckets.x10_plus++;

    // MC Buckets
    if (entryMc > 0) {
      const bucket = stats.mcBuckets.find(b => entryMc >= b.min && entryMc < b.max);
      if (bucket) {
        bucket.count++;
        if (mult > 2) bucket.wins++;
        bucket.avgMult += mult;
      }
    }
  }

  // Finalize averages
  stats.mcBuckets.forEach(b => {
    if (b.count > 0) b.avgMult /= b.count;
  });

  return stats;
};
