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
  
  // V2 Metrics
  avgTimeTo2x: number; // minutes
  avgTimeTo3x: number; // minutes
  avgTimeTo5x: number; // minutes
  avgTimeTo10x: number; // minutes
  avgStagnationTime: number; // minutes (time < 1.1x before pump)
  avgDrawdownDuration: number; // minutes (time underwater before ATH)
  speedScore: number; // 0-100 (100 = Instant moons, 0 = Slow grinds)
  diamondHands: number; // % of signals held > 24h
  avgLifespan: number; // Avg duration of tracking before inactive (minutes)
  topSector: string; // Most common tag
  // User Stats Enhancements
  paperHands: number; // % sold before peak (inferred from price action)
  volatilityIndex: number; // Standard deviation of market cap multiples
  reliabilityTier: string; // 'S', 'A', 'B', 'C', 'F'
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
      followThrough: 0,
      avgTimeTo2x: 0,
      avgTimeTo3x: 0,
      avgTimeTo5x: 0,
      avgTimeTo10x: 0,
      avgStagnationTime: 0,
      avgDrawdownDuration: 0,
      speedScore: 0,
      diamondHands: 0,
      avgLifespan: 0,
      topSector: 'N/A',
      paperHands: 0,
      volatilityIndex: 0,
      reliabilityTier: 'F'
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
  
  // V2 Accumulators
  let timeTo2xSum = 0;
  let timeTo2xCount = 0;
  let timeTo3xSum = 0;
  let timeTo3xCount = 0;
  let timeTo5xSum = 0;
  let timeTo5xCount = 0;
  let timeTo10xSum = 0;
  let timeTo10xCount = 0;
  let stagnationTimeSum = 0;
  let stagnationTimeCount = 0;
  let drawdownDurationSum = 0;
  let drawdownDurationCount = 0;
  let diamondHandsCount = 0; // Held > 24h
  let lifespanSum = 0; // Tracking duration
  
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
    
    // V2 Time Metrics (from new schema fields or fallback)
    const time2x = s.metrics.timeTo2x;
    if (time2x) {
        timeTo2xSum += time2x / (1000 * 60);
        timeTo2xCount++;
    } else if (mult > 2 && s.metrics.athAt && s.detectedAt) {
        // Fallback: Use ATH time if > 2x (Approximate)
        // Better: Don't guess. 
    }

    const time3x = s.metrics.timeTo3x;
    if (time3x) {
        timeTo3xSum += time3x / (1000 * 60);
        timeTo3xCount++;
    }

    const time5x = s.metrics.timeTo5x;
    if (time5x) {
        timeTo5xSum += time5x / (1000 * 60);
        timeTo5xCount++;
    }

    const time10x = s.metrics.timeTo10x;
    if (time10x) {
        timeTo10xSum += time10x / (1000 * 60);
        timeTo10xCount++;
    }

    // Stagnation Time and Drawdown Duration (from new schema fields)
    if (s.metrics.stagnationTime) {
        stagnationTimeSum += s.metrics.stagnationTime / (1000 * 60);
        stagnationTimeCount++;
    }
    
    if (s.metrics.drawdownDuration) {
        drawdownDurationSum += s.metrics.drawdownDuration / (1000 * 60);
        drawdownDurationCount++;
    }

    // Diamond Hands (>24h active tracking or held)
    const ageMs = Date.now() - new Date(s.detectedAt).getTime();
    const ageHrs = ageMs / (1000 * 60 * 60);
    // If signal is still ACTIVE and > 24h old, OR trackingEndAt was > 24h
    let duration = ageHrs;
    if (s.trackingEndAt) {
        duration = (new Date(s.trackingEndAt).getTime() - new Date(s.detectedAt).getTime()) / (1000 * 60 * 60);
    }
    
    // Only count if it was profitable (otherwise holding bags)
    if (duration > 24 && mult > 1.5) {
        diamondHandsCount++;
    }
    
    lifespanSum += duration * 60; // minutes

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
  
  // V2 Averages
  const avgTimeTo2x = timeTo2xCount ? timeTo2xSum / timeTo2xCount : 0;
  const avgTimeTo3x = timeTo3xCount ? timeTo3xSum / timeTo3xCount : 0;
  const avgTimeTo5x = timeTo5xCount ? timeTo5xSum / timeTo5xCount : 0;
  const avgTimeTo10x = timeTo10xCount ? timeTo10xSum / timeTo10xCount : 0;
  const avgStagnationTime = stagnationTimeCount ? stagnationTimeSum / stagnationTimeCount : 0;
  const avgDrawdownDuration = drawdownDurationCount ? drawdownDurationSum / drawdownDurationCount : 0;
  const diamondHands = count ? diamondHandsCount / count : 0;
  const avgLifespan = count ? lifespanSum / count : 0;
  
  // Speed Score: 100 = <5m avg time to peak. 0 = >48h.
  // Formula: Decay based on minutes.
  // If avgTime < 5 => 100.
  // If avgTime = 60 (1h) => 80.
  // If avgTime = 1440 (24h) => 20.
  let speedScore = 0;
  if (avgTimeToAth > 0) {
      if (avgTimeToAth < 5) speedScore = 100;
      else if (avgTimeToAth < 30) speedScore = 90;
      else if (avgTimeToAth < 60) speedScore = 80;
      else if (avgTimeToAth < 240) speedScore = 60; // 4h
      else if (avgTimeToAth < 1440) speedScore = 40; // 24h
      else speedScore = 20;
  }

  const rugRate = count ? rugCount / count : 0;
  const mcapAvg = mcapCount ? totalMcap / mcapCount : 0;
  const sniperScore = count ? (sniperCount / count) * 100 : 0;
  
  // Consistency (Std Dev) - same as Volatility Index
  let variance = 0;
  if (count > 1) {
      const mean = avgMultiple;
      variance = multiples.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / count;
  }
  const consistency = Math.sqrt(variance); // Standard Deviation. Lower is more consistent? 
  const volatilityIndex = consistency; // Same calculation
  
  // Paper Hands Score: % of signals where price dropped significantly from ATH before tracking ended
  // Infer from: if currentMultiple < athMultiple * 0.7, likely sold before peak
  let paperHandsCount = 0;
  for (const s of signals) {
    if (s.metrics) {
      const currentMult = s.metrics.currentMultiple || 0;
      const athMult = s.metrics.athMultiple || 0;
      // If current is < 70% of ATH, likely paper hands
      if (athMult > 0 && currentMult < athMult * 0.7 && athMult > 1.5) {
        paperHandsCount++;
      }
    }
  }
  const paperHands = count ? paperHandsCount / count : 0;
  
  // Favorite Sector: Extract from category or tags
  const categoryCounts = new Map<string, number>();
  for (const s of signals) {
    const cat = s.category || 'Uncategorized';
    categoryCounts.set(cat, (categoryCounts.get(cat) || 0) + 1);
  }
  const topSector = categoryCounts.size > 0 
    ? Array.from(categoryCounts.entries()).sort((a, b) => b[1] - a[1])[0][0]
    : 'N/A';
  
  // Reliability Tier: S/A/B/C/F based on win rate + consistency
  let reliabilityTier = 'F';
  if (winRate >= 0.6 && consistency < 2.0) reliabilityTier = 'S'; // Consistent winner
  else if (winRate >= 0.5 && consistency < 3.0) reliabilityTier = 'A'; // Good but volatile
  else if (winRate >= 0.4 && consistency < 4.0) reliabilityTier = 'B'; // Decent
  else if (winRate >= 0.3) reliabilityTier = 'C'; // Below average
  // else F (already set)
  
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
    followThrough,
    avgTimeTo2x,
    avgTimeTo3x,
    avgTimeTo5x,
    avgTimeTo10x,
    avgStagnationTime,
    avgDrawdownDuration,
    speedScore,
    diamondHands,
    avgLifespan,
    topSector,
    paperHands,
    volatilityIndex,
    reliabilityTier
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
  timeOfDay: Array<{ hour: number; count: number; winRate: number; avgMult: number }>;
  dayOfWeek: Array<{ day: string; count: number; winRate: number; avgMult: number }>;
  groupWinRates: Array<{ groupName: string; count: number; winRate: number; avgMult: number }>;
  volumeCorrelation: {
    highVolume: { count: number; winRate: number; avgMult: number };
    lowVolume: { count: number; winRate: number; avgMult: number };
  };
  rugPullRatio: number;
  moonshotProbability: number;
  streakAnalysis: {
    after3Losses: { count: number; winRate: number };
    after3Wins: { count: number; winRate: number };
  };
  tokenAgePreference: {
    newPairs: { count: number; winRate: number; avgMult: number }; // 0-5m old
    established: { count: number; winRate: number; avgMult: number }; // 1h+
  };
  liquidityVsReturn: {
    highLiquidity: { count: number; winRate: number; avgMult: number };
    lowLiquidity: { count: number; winRate: number; avgMult: number };
  };
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

  // 2. Fetch signals with all needed relations
  const signals = await prisma.signal.findMany({
    where: {
      detectedAt: { gte: since },
      metrics: { isNot: null },
      OR: [
          { chatId: { in: ownedChatIds } },
          { id: { in: forwardedSignalIds } }
      ]
    },
    include: { 
      metrics: true,
      group: true,
      priceSamples: {
        orderBy: { sampledAt: 'asc' },
        take: 1 // First sample for volume/liquidity
      }
    }
  });

  // 3. Process Distributions - Initialize all stats
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
    timeOfDay: Array.from({ length: 24 }, (_, i) => ({ hour: i, count: 0, winRate: 0, avgMult: 0 })),
    dayOfWeek: [
      { day: 'Mon', count: 0, winRate: 0, avgMult: 0 },
      { day: 'Tue', count: 0, winRate: 0, avgMult: 0 },
      { day: 'Wed', count: 0, winRate: 0, avgMult: 0 },
      { day: 'Thu', count: 0, winRate: 0, avgMult: 0 },
      { day: 'Fri', count: 0, winRate: 0, avgMult: 0 },
      { day: 'Sat', count: 0, winRate: 0, avgMult: 0 },
      { day: 'Sun', count: 0, winRate: 0, avgMult: 0 },
    ],
    groupWinRates: [],
    volumeCorrelation: { highVolume: { count: 0, winRate: 0, avgMult: 0 }, lowVolume: { count: 0, winRate: 0, avgMult: 0 } },
    rugPullRatio: 0,
    moonshotProbability: 0,
    streakAnalysis: { after3Losses: { count: 0, winRate: 0 }, after3Wins: { count: 0, winRate: 0 } },
    tokenAgePreference: { newPairs: { count: 0, winRate: 0, avgMult: 0 }, established: { count: 0, winRate: 0, avgMult: 0 } },
    liquidityVsReturn: { highLiquidity: { count: 0, winRate: 0, avgMult: 0 }, lowLiquidity: { count: 0, winRate: 0, avgMult: 0 } },
    totalSignals: signals.length
  };

  // Group tracking for win rates
  const groupStats = new Map<string, { count: number; wins: number; totalMult: number }>();
  
  // Streak tracking
  const sortedSignals = [...signals].sort((a, b) => a.detectedAt.getTime() - b.detectedAt.getTime());
  let currentStreak = 0;
  let streakType: 'win' | 'loss' = 'loss';

  for (const s of sortedSignals) {
    if (!s.metrics) continue;
    const mult = s.metrics.athMultiple || 0;
    const entryMc = s.entryMarketCap || 0;
    const isWin = mult > 2;
    const isRug = mult < 0.5 || (s.metrics.maxDrawdown || 0) < -0.9;
    const isMoonshot = mult > 10;

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
        if (isWin) bucket.wins++;
        bucket.avgMult += mult;
      }
    }

    // Time of Day Analysis (UTC)
    const hour = s.detectedAt.getUTCHours();
    stats.timeOfDay[hour].count++;
    if (isWin) stats.timeOfDay[hour].winRate++;
    stats.timeOfDay[hour].avgMult += mult;

    // Day of Week Analysis
    const dayIndex = s.detectedAt.getUTCDay(); // 0=Sun, 1=Mon, etc.
    const dayMap = [6, 0, 1, 2, 3, 4, 5]; // Map to our array (Mon=0)
    const mappedDay = dayMap[dayIndex];
    stats.dayOfWeek[mappedDay].count++;
    if (isWin) stats.dayOfWeek[mappedDay].winRate++;
    stats.dayOfWeek[mappedDay].avgMult += mult;

    // Group Win Rates
    const groupName = s.group?.name || `Group ${s.groupId || 'Unknown'}`;
    if (!groupStats.has(groupName)) {
      groupStats.set(groupName, { count: 0, wins: 0, totalMult: 0 });
    }
    const gStat = groupStats.get(groupName)!;
    gStat.count++;
    if (isWin) gStat.wins++;
    gStat.totalMult += mult;

    // Volume Correlation (using first price sample)
    const firstSample = s.priceSamples[0];
    const volume = firstSample?.volume || 0;
    if (volume > 10000) {
      stats.volumeCorrelation.highVolume.count++;
      if (isWin) stats.volumeCorrelation.highVolume.winRate++;
      stats.volumeCorrelation.highVolume.avgMult += mult;
    } else if (volume > 0 && volume < 1000) {
      stats.volumeCorrelation.lowVolume.count++;
      if (isWin) stats.volumeCorrelation.lowVolume.winRate++;
      stats.volumeCorrelation.lowVolume.avgMult += mult;
    }

    // Rug Pull Ratio
    if (isRug) stats.rugPullRatio++;

    // Moonshot Probability
    if (isMoonshot) stats.moonshotProbability++;

    // Streak Analysis
    if (isWin) {
      if (streakType === 'loss' && currentStreak >= 3) {
        stats.streakAnalysis.after3Losses.count++;
        stats.streakAnalysis.after3Losses.winRate++;
      }
      currentStreak = currentStreak > 0 && streakType === 'win' ? currentStreak + 1 : 1;
      streakType = 'win';
    } else {
      if (streakType === 'win' && currentStreak >= 3) {
        stats.streakAnalysis.after3Wins.count++;
        // Next signal after 3 wins
      }
      currentStreak = currentStreak > 0 && streakType === 'loss' ? currentStreak + 1 : 1;
      streakType = 'loss';
    }

    // Token Age Preference (using detectedAt vs firstPoolCreatedAt from meta - approximated)
    // For now, use time since detection as proxy (new pairs = detected very early)
    const ageMinutes = (Date.now() - s.detectedAt.getTime()) / (1000 * 60);
    if (ageMinutes < 5) {
      stats.tokenAgePreference.newPairs.count++;
      if (isWin) stats.tokenAgePreference.newPairs.winRate++;
      stats.tokenAgePreference.newPairs.avgMult += mult;
    } else if (ageMinutes > 60) {
      stats.tokenAgePreference.established.count++;
      if (isWin) stats.tokenAgePreference.established.winRate++;
      stats.tokenAgePreference.established.avgMult += mult;
    }

    // Liquidity vs Return
    const liquidity = firstSample?.liquidity || 0;
    if (liquidity > 50000) {
      stats.liquidityVsReturn.highLiquidity.count++;
      if (isWin) stats.liquidityVsReturn.highLiquidity.winRate++;
      stats.liquidityVsReturn.highLiquidity.avgMult += mult;
    } else if (liquidity > 0 && liquidity < 10000) {
      stats.liquidityVsReturn.lowLiquidity.count++;
      if (isWin) stats.liquidityVsReturn.lowLiquidity.winRate++;
      stats.liquidityVsReturn.lowLiquidity.avgMult += mult;
    }
  }

  // Finalize averages and percentages
  stats.mcBuckets.forEach(b => {
    if (b.count > 0) {
      b.avgMult /= b.count;
      // Keep wins as count, winRate will be calculated in UI
    }
  });

  // Time of Day - convert wins to win rate
  stats.timeOfDay.forEach(h => {
    if (h.count > 0) {
      h.winRate = h.winRate / h.count;
      h.avgMult /= h.count;
    }
  });

  // Day of Week - convert wins to win rate
  stats.dayOfWeek.forEach(d => {
    if (d.count > 0) {
      d.winRate = d.winRate / d.count;
      d.avgMult /= d.count;
    }
  });

  // Group Win Rates
  for (const [name, gStat] of groupStats.entries()) {
    if (gStat.count > 0) {
      stats.groupWinRates.push({
        groupName: name,
        count: gStat.count,
        winRate: gStat.wins / gStat.count,
        avgMult: gStat.totalMult / gStat.count
      });
    }
  }
  stats.groupWinRates.sort((a, b) => b.winRate - a.winRate);

  // Volume Correlation - convert to win rates
  if (stats.volumeCorrelation.highVolume.count > 0) {
    stats.volumeCorrelation.highVolume.winRate /= stats.volumeCorrelation.highVolume.count;
    stats.volumeCorrelation.highVolume.avgMult /= stats.volumeCorrelation.highVolume.count;
  }
  if (stats.volumeCorrelation.lowVolume.count > 0) {
    stats.volumeCorrelation.lowVolume.winRate /= stats.volumeCorrelation.lowVolume.count;
    stats.volumeCorrelation.lowVolume.avgMult /= stats.volumeCorrelation.lowVolume.count;
  }

  // Rug Pull Ratio & Moonshot Probability (as percentages)
  if (stats.totalSignals > 0) {
    stats.rugPullRatio = stats.rugPullRatio / stats.totalSignals;
    stats.moonshotProbability = stats.moonshotProbability / stats.totalSignals;
  }

  // Streak Analysis - convert to win rates
  if (stats.streakAnalysis.after3Losses.count > 0) {
    stats.streakAnalysis.after3Losses.winRate /= stats.streakAnalysis.after3Losses.count;
  }
  if (stats.streakAnalysis.after3Wins.count > 0) {
    stats.streakAnalysis.after3Wins.winRate /= stats.streakAnalysis.after3Wins.count;
  }

  // Token Age Preference
  if (stats.tokenAgePreference.newPairs.count > 0) {
    stats.tokenAgePreference.newPairs.winRate /= stats.tokenAgePreference.newPairs.count;
    stats.tokenAgePreference.newPairs.avgMult /= stats.tokenAgePreference.newPairs.count;
  }
  if (stats.tokenAgePreference.established.count > 0) {
    stats.tokenAgePreference.established.winRate /= stats.tokenAgePreference.established.count;
    stats.tokenAgePreference.established.avgMult /= stats.tokenAgePreference.established.count;
  }

  // Liquidity vs Return
  if (stats.liquidityVsReturn.highLiquidity.count > 0) {
    stats.liquidityVsReturn.highLiquidity.winRate /= stats.liquidityVsReturn.highLiquidity.count;
    stats.liquidityVsReturn.highLiquidity.avgMult /= stats.liquidityVsReturn.highLiquidity.count;
  }
  if (stats.liquidityVsReturn.lowLiquidity.count > 0) {
    stats.liquidityVsReturn.lowLiquidity.winRate /= stats.liquidityVsReturn.lowLiquidity.count;
    stats.liquidityVsReturn.lowLiquidity.avgMult /= stats.liquidityVsReturn.lowLiquidity.count;
  }

  return stats;
};
