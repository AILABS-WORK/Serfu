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
  } | null;
  avgDrawdown: number;
  avgTimeToAth: number; // in minutes
  score: number; // Reliability score
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
      score: 0
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

  for (const s of signals) {
    if (!s.metrics) continue;
    
    // Multiple
    const mult = s.metrics.athMultiple || 0;
    totalMult += mult;
    if (mult > 2) wins++;
    if (mult > 5) wins5x++;
    if (mult > maxMult) {
      maxMult = mult;
      bestSignal = s;
    }

    // Drawdown (stored as negative decimal e.g. -0.4)
    totalDrawdown += s.metrics.maxDrawdown || 0;

    // Time to ATH
    // We compare detectedAt (signal creation) with athAt
    if (s.metrics.athAt && s.detectedAt) {
      const diffMs = new Date(s.metrics.athAt).getTime() - new Date(s.detectedAt).getTime();
      if (diffMs > 0) {
        totalTime += diffMs / (1000 * 60); // minutes
        timeCount++;
      }
    }
  }

  const count = signals.length;
  const avgMultiple = count ? totalMult / count : 0;
  const winRate = count ? wins / count : 0;
  const winRate5x = count ? wins5x / count : 0;
  const avgDrawdown = count ? totalDrawdown / count : 0; // e.g. -0.25
  const avgTimeToAth = timeCount ? totalTime / timeCount : 0;

  // Improved Score: 
  // Base: WinRate * 40
  // Bonus: AvgMult * 5
  // Bonus: WinRate5x * 20 (reward moonshots)
  // Penalty: Drawdown * 50 (punish rekt calls heavily)
  // WinRate 0.5 -> 20
  // WinRate5x 0.1 -> 2
  // AvgMult 3x -> 15
  // Drawdown -0.3 -> +15
  // Total ~ 52
  const score = (winRate * 40) + (winRate5x * 20) + (avgMultiple * 5) - (avgDrawdown * 50);

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
      multiple: bestSignal.metrics?.athMultiple || 0
    } : null,
    score
  };
};

export const getGroupStats = async (groupId: number, timeframe: TimeFrame): Promise<EntityStats | null> => {
  const group = await prisma.group.findUnique({ where: { id: groupId } });
  if (!group) return null;

  const since = getDateFilter(timeframe);
  const signals = await prisma.signal.findMany({
    where: {
      groupId,
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
