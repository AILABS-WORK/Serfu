import { prisma } from '../db';
import { Signal, SignalMetric } from '@prisma/client';

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
