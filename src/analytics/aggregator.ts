import { prisma } from '../db';
import { Signal, SignalMetric } from '../generated/client/client';

export interface EntityStats {
  id: number;
  name: string;
  totalSignals: number;
  avgMultiple: number; // e.g. 3.5x
  winRate: number; // % of signals > 2x
  bestCall: {
    mint: string;
    symbol: string;
    multiple: number;
  } | null;
  avgDrawdown: number;
  score: number; // Reliability score
}

type TimeFrame = '7D' | '30D' | 'ALL';

const getDateFilter = (timeframe: TimeFrame) => {
  const now = new Date();
  if (timeframe === '7D') return new Date(now.setDate(now.getDate() - 7));
  if (timeframe === '30D') return new Date(now.setDate(now.getDate() - 30));
  return new Date(0); // ALL
};

const calculateStats = (signals: (Signal & { metrics: SignalMetric | null })[]): EntityStats => {
  if (!signals.length) {
    return {
      id: 0,
      name: '',
      totalSignals: 0,
      avgMultiple: 0,
      winRate: 0,
      bestCall: null,
      avgDrawdown: 0,
      score: 0
    };
  }

  let totalMult = 0;
  let wins = 0;
  let totalDrawdown = 0;
  let bestSignal: any = null;
  let maxMult = 0;

  for (const s of signals) {
    if (!s.metrics) continue;
    
    // Multiple
    const mult = s.metrics.athMultiple || 0;
    totalMult += mult;
    if (mult > 2) wins++;
    if (mult > maxMult) {
      maxMult = mult;
      bestSignal = s;
    }

    // Drawdown (stored as negative decimal e.g. -0.4)
    totalDrawdown += s.metrics.maxDrawdown || 0;
  }

  const count = signals.length;
  const avgMultiple = count ? totalMult / count : 0;
  const winRate = count ? wins / count : 0;
  const avgDrawdown = count ? totalDrawdown / count : 0; // e.g. -0.25

  // Simple Score: (WinRate * 50) + (AvgMult * 10) - (Drawdown * 10)
  // WinRate 0.5 -> 25
  // AvgMult 3x -> 30
  // Drawdown -0.3 -> +3 (minus negative)
  // Total ~ 58
  const score = (winRate * 50) + (avgMultiple * 10) - (avgDrawdown * 100);

  return {
    id: 0, // Placeholder
    name: '',
    totalSignals: count,
    avgMultiple,
    winRate,
    avgDrawdown,
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
      createdAt: { gte: since },
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
      createdAt: { gte: since },
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
      createdAt: { gte: since },
      metrics: { isNot: null }
    },
    include: { metrics: true, group: true, user: true }
  });

  // 2. Group by Entity
  const entityMap = new Map<number, typeof signals>();
  const nameMap = new Map<number, string>();

  for (const s of signals) {
    const id = type === 'GROUP' ? s.groupId : s.userId;
    if (!id) continue;
    
    if (!entityMap.has(id)) entityMap.set(id, []);
    entityMap.get(id)!.push(s);

    if (!nameMap.has(id)) {
      const name = type === 'GROUP' 
        ? (s.group?.name || `Group ${s.group?.chatId}`) 
        : (s.user?.username || s.user?.firstName || 'Unknown');
      nameMap.set(id, name || 'Unknown');
    }
  }

  // 3. Calculate Stats for each
  const results: EntityStats[] = [];
  for (const [id, entitySignals] of entityMap.entries()) {
    const stats = calculateStats(entitySignals);
    stats.id = id;
    stats.name = nameMap.get(id) || 'Unknown';
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

