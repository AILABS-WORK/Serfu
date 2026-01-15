import { prisma } from '../db';
import { Prisma, Signal, SignalMetric } from '../generated/client';

export interface EntityStats {
  id: number;
  name: string;
  totalSignals: number;
  avgMultiple: number; // e.g. 3.5x
  winRate: number; // % of signals > 2x
  winRate5x: number; // % of signals > 5x
  hit2Count: number;
  hit5Count: number;
  hit10Count: number;
  moonCount: number;
  moonRate: number;
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
  avgEntryMarketCap: number;
  avgAthMarketCap: number;
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

type TimeFrame = '1D' | '7D' | '30D' | 'ALL' | string;

// Type alias for signal with metrics loaded (and optional relations allowed)
type SignalWithMetrics = Signal & { 
  metrics: SignalMetric | null;
  // Allow other relations to pass through
  [key: string]: any; 
};

const getDateFilter = (timeframe: TimeFrame) => {
  const now = new Date();
  if (timeframe === '1D') return new Date(now.setDate(now.getDate() - 1));
  if (timeframe === '7D') return new Date(now.setDate(now.getDate() - 7));
  if (timeframe === '30D') return new Date(now.setDate(now.getDate() - 30));
  if (timeframe === 'ALL') return new Date(0);
  const custom = String(timeframe).toUpperCase();
  const match = custom.match(/^(\d+)(H|D|W|M)$/);
  if (!match) return new Date(0);
  const value = parseInt(match[1], 10);
  const unit = match[2];
  const hours = unit === 'H' ? value : unit === 'D' ? value * 24 : unit === 'W' ? value * 24 * 7 : value * 24 * 30;
  return new Date(Date.now() - hours * 60 * 60 * 1000);
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
      hit2Count: 0,
      hit5Count: 0,
      hit10Count: 0,
      moonCount: 0,
      moonRate: 0,
      bestCall: null,
      avgDrawdown: 0,
      avgTimeToAth: 0,
      score: 0,
      consistency: 0,
      rugRate: 0,
      mcapAvg: 0,
      avgEntryMarketCap: 0,
      avgAthMarketCap: 0,
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
  let wins10x = 0;
  let totalDrawdown = 0;
  let totalTime = 0; // minutes
  let timeCount = 0;
  let bestSignal: any = null;
  let maxMult = 0;
  
  // New Metrics Accumulators
  let rugCount = 0;
  let totalMcap = 0;
  let mcapCount = 0;
  let totalAthMcap = 0;
  let athMcapCount = 0;
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
    if (mult > 10) wins10x++;
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
    if (s.metrics?.athMarketCap) {
        totalAthMcap += s.metrics.athMarketCap;
        athMcapCount++;
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
  const winRate10x = count ? wins10x / count : 0;
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
  const avgAthMarketCap = athMcapCount ? totalAthMcap / athMcapCount : 0;
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
    hit2Count: wins,
    hit5Count: wins5x,
    hit10Count: wins10x,
    moonCount: wins5x,
    moonRate: count ? wins5x / count : 0,
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
    avgEntryMarketCap: mcapAvg,
    avgAthMarketCap,
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
  id: number,
  mint: string,
  symbol: string,
  athMultiple: number,
  sourceName: string,
  detectedAt: Date,
  entryMarketCap: number | null,
  athMarketCap: number | null,
  currentMarketCap: number | null,
  timeToAth: number | null
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

  // Get current market caps for all signals
  const { getMultipleTokenPrices } = await import('../providers/jupiter');
  const mints = signals.map(s => s.mint);
  const prices = await getMultipleTokenPrices(mints);

  return signals.map(s => {
    const currentPrice = prices[s.mint] || null;
    const supply = s.entrySupply;
    const currentMc = currentPrice && supply ? currentPrice * supply : null;
    
    // Calculate time to ATH in minutes
    let timeToAth: number | null = null;
    if (s.metrics?.athAt && s.detectedAt) {
      timeToAth = (s.metrics.athAt.getTime() - s.detectedAt.getTime()) / (1000 * 60);
    }
    
    return {
      id: s.id,
      mint: s.mint,
      symbol: s.symbol || 'Unknown',
      athMultiple: s.metrics?.athMultiple || 0,
      sourceName: s.user?.username || s.group?.name || 'Unknown',
      detectedAt: s.detectedAt,
      entryMarketCap: s.entryMarketCap,
      athMarketCap: s.metrics?.athMarketCap || null,
      currentMarketCap: currentMc,
      timeToAth
    };
  });
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
  timeOfDayByDay: Array<{ day: string; hours: Array<{ hour: number; count: number; winRate: number; avgMult: number }> }>;
  dayOfWeek: Array<{ day: string; count: number; winRate: number; avgMult: number }>;
  groupWinRates: Array<{ 
    groupName: string; 
    count: number; 
    winRate: number; 
    avgMult: number; 
    avgEntryMc: number; 
    avgAthMult: number; 
    avgTimeToAth: number; 
    moonRate: number;
  }>;
  volumeBuckets: Array<{
    label: string;
    min: number;
    max: number;
    count: number;
    wins: number;
    avgMult: number;
  }>;
  rugPullRatio: number;
  moonshotProbability: number;
  moonshotCounts: { gt2x: number; gt5x: number; gt10x: number };
  moonshotTimes: { timeTo2x: number; timeTo5x: number; timeTo10x: number };
  streakAnalysis: {
    after1Loss: { count: number; winRate: number };
    after2Losses: { count: number; winRate: number };
    after3Losses: { count: number; winRate: number };
    after1Win: { count: number; winRate: number };
    after2Wins: { count: number; winRate: number };
    after3Wins: { count: number; winRate: number };
  };
  tokenAgeBuckets: Array<{
    label: string;
    minMinutes: number;
    maxMinutes: number;
    count: number;
    wins: number;
    avgMult: number;
  }>;
  tokenAgeHasData: boolean;
  liquidityBuckets: Array<{
    label: string;
    min: number;
    max: number;
    count: number;
    wins: number;
    avgMult: number;
  }>;
  currentStreak: { type: 'win' | 'loss'; count: number };
  totalSignals: number;
}

export const getDistributionStats = async (
  ownerTelegramId: bigint, 
  timeframe: TimeFrame,
  target?: { type: 'OVERALL' | 'GROUP' | 'USER'; id?: number }
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
  const targetType = target?.type || 'OVERALL';
  const allowedGroupIds = new Set(userGroups.map(g => g.id));

  let scopeFilter: any = {
    OR: [
      { chatId: { in: ownedChatIds } },
      { id: { in: forwardedSignalIds } }
    ]
  };

  if (targetType === 'GROUP' && target?.id && allowedGroupIds.has(target.id)) {
    scopeFilter = { groupId: target.id };
  } else if (targetType === 'USER' && target?.id) {
    scopeFilter = { userId: target.id };
  }

  const signals = await prisma.signal.findMany({
    where: {
      detectedAt: { gte: since },
      metrics: { isNot: null },
      ...scopeFilter
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
      { label: '250k-500k', min: 250000, max: 500000, count: 0, wins: 0, avgMult: 0 },
      { label: '500k-1M', min: 500000, max: 1000000, count: 0, wins: 0, avgMult: 0 },
      { label: '1M+', min: 1000000, max: 1000000000, count: 0, wins: 0, avgMult: 0 },
    ],
    timeOfDay: Array.from({ length: 24 }, (_, i) => ({ hour: i, count: 0, winRate: 0, avgMult: 0 })),
    timeOfDayByDay: [
      { day: 'Mon', hours: Array.from({ length: 24 }, (_, i) => ({ hour: i, count: 0, winRate: 0, avgMult: 0 })) },
      { day: 'Tue', hours: Array.from({ length: 24 }, (_, i) => ({ hour: i, count: 0, winRate: 0, avgMult: 0 })) },
      { day: 'Wed', hours: Array.from({ length: 24 }, (_, i) => ({ hour: i, count: 0, winRate: 0, avgMult: 0 })) },
      { day: 'Thu', hours: Array.from({ length: 24 }, (_, i) => ({ hour: i, count: 0, winRate: 0, avgMult: 0 })) },
      { day: 'Fri', hours: Array.from({ length: 24 }, (_, i) => ({ hour: i, count: 0, winRate: 0, avgMult: 0 })) },
      { day: 'Sat', hours: Array.from({ length: 24 }, (_, i) => ({ hour: i, count: 0, winRate: 0, avgMult: 0 })) },
      { day: 'Sun', hours: Array.from({ length: 24 }, (_, i) => ({ hour: i, count: 0, winRate: 0, avgMult: 0 })) },
    ],
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
    volumeBuckets: [
      { label: '0-1k', min: 0, max: 1000, count: 0, wins: 0, avgMult: 0 },
      { label: '1k-5k', min: 1000, max: 5000, count: 0, wins: 0, avgMult: 0 },
      { label: '5k-10k', min: 5000, max: 10000, count: 0, wins: 0, avgMult: 0 },
      { label: '10k-25k', min: 10000, max: 25000, count: 0, wins: 0, avgMult: 0 },
      { label: '25k-50k', min: 25000, max: 50000, count: 0, wins: 0, avgMult: 0 },
      { label: '50k-100k', min: 50000, max: 100000, count: 0, wins: 0, avgMult: 0 },
      { label: '100k+', min: 100000, max: 1000000000, count: 0, wins: 0, avgMult: 0 },
    ],
    rugPullRatio: 0,
    moonshotProbability: 0,
    moonshotCounts: { gt2x: 0, gt5x: 0, gt10x: 0 },
    moonshotTimes: { timeTo2x: 0, timeTo5x: 0, timeTo10x: 0 },
    streakAnalysis: {
      after1Loss: { count: 0, winRate: 0 },
      after2Losses: { count: 0, winRate: 0 },
      after3Losses: { count: 0, winRate: 0 },
      after1Win: { count: 0, winRate: 0 },
      after2Wins: { count: 0, winRate: 0 },
      after3Wins: { count: 0, winRate: 0 }
    },
    tokenAgeBuckets: [
      { label: '0-5m', minMinutes: 0, maxMinutes: 5, count: 0, wins: 0, avgMult: 0 },
      { label: '5-15m', minMinutes: 5, maxMinutes: 15, count: 0, wins: 0, avgMult: 0 },
      { label: '15-45m', minMinutes: 15, maxMinutes: 45, count: 0, wins: 0, avgMult: 0 },
      { label: '45m-2h', minMinutes: 45, maxMinutes: 120, count: 0, wins: 0, avgMult: 0 },
      { label: '2h-6h', minMinutes: 120, maxMinutes: 360, count: 0, wins: 0, avgMult: 0 },
      { label: '6h-24h', minMinutes: 360, maxMinutes: 1440, count: 0, wins: 0, avgMult: 0 },
      { label: '1d-7d', minMinutes: 1440, maxMinutes: 10080, count: 0, wins: 0, avgMult: 0 },
      { label: '7d+', minMinutes: 10080, maxMinutes: 1000000000, count: 0, wins: 0, avgMult: 0 },
    ],
    tokenAgeHasData: false,
    liquidityBuckets: [
      { label: '0-5k', min: 0, max: 5000, count: 0, wins: 0, avgMult: 0 },
      { label: '5k-10k', min: 5000, max: 10000, count: 0, wins: 0, avgMult: 0 },
      { label: '10k-25k', min: 10000, max: 25000, count: 0, wins: 0, avgMult: 0 },
      { label: '25k-50k', min: 25000, max: 50000, count: 0, wins: 0, avgMult: 0 },
      { label: '50k-100k', min: 50000, max: 100000, count: 0, wins: 0, avgMult: 0 },
      { label: '100k+', min: 100000, max: 1000000000, count: 0, wins: 0, avgMult: 0 },
    ],
    currentStreak: { type: 'loss', count: 0 },
    totalSignals: signals.length
  };

  // Group tracking for win rates
  const groupStats = new Map<string, { 
    count: number; 
    wins: number; 
    totalMult: number; 
    totalEntryMc: number;
    entryMcCount: number;
    totalAthMult: number;
    totalTimeToAth: number;
    timeToAthCount: number;
    moonCount: number;
  }>();
  
  // Streak tracking
  const sortedSignals = [...signals].sort((a, b) => a.detectedAt.getTime() - b.detectedAt.getTime());
  let currentStreak = 0;
  let streakType: 'win' | 'loss' = 'loss';
  let lastStreakWasWin = false;

  // Moonshot time accumulators
  let timeTo2xSum = 0;
  let timeTo2xCount = 0;
  let timeTo5xSum = 0;
  let timeTo5xCount = 0;
  let timeTo10xSum = 0;
  let timeTo10xCount = 0;

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
    const dayHour = stats.timeOfDayByDay[mappedDay].hours[hour];
    dayHour.count++;
    if (isWin) dayHour.winRate++;
    dayHour.avgMult += mult;

    // Group Win Rates
    const groupName = s.group?.name || `Group ${s.groupId || 'Unknown'}`;
    if (!groupStats.has(groupName)) {
      groupStats.set(groupName, { 
        count: 0, 
        wins: 0, 
        totalMult: 0, 
        totalEntryMc: 0, 
        entryMcCount: 0, 
        totalAthMult: 0,
        totalTimeToAth: 0,
        timeToAthCount: 0,
        moonCount: 0
      });
    }
    const gStat = groupStats.get(groupName)!;
    gStat.count++;
    if (isWin) gStat.wins++;
    gStat.totalMult += mult;
    if (entryMc > 0) {
      gStat.totalEntryMc += entryMc;
      gStat.entryMcCount++;
    }
    gStat.totalAthMult += mult;
    if (s.metrics?.timeToAth) {
      gStat.totalTimeToAth += s.metrics.timeToAth / (1000 * 60);
      gStat.timeToAthCount++;
    }
    if (mult > 5) gStat.moonCount++;

    // Volume Correlation (using first price sample)
    const firstSample = s.priceSamples[0];
    const volume = firstSample?.volume || 0;
    if (volume > 0) {
      const vBucket = stats.volumeBuckets.find(b => volume >= b.min && volume < b.max);
      if (vBucket) {
        vBucket.count++;
        if (isWin) vBucket.wins++;
        vBucket.avgMult += mult;
      }
    }

    // Rug Pull Ratio
    if (isRug) stats.rugPullRatio++;

    // Moonshot Probability
    if (mult > 2) stats.moonshotCounts.gt2x++;
    if (mult > 5) stats.moonshotCounts.gt5x++;
    if (mult > 10) stats.moonshotCounts.gt10x++;
    if (isMoonshot) stats.moonshotProbability++;

    // Moonshot Times (ms -> minutes)
    if (s.metrics?.timeTo2x) {
      timeTo2xSum += s.metrics.timeTo2x / (1000 * 60);
      timeTo2xCount++;
    }
    if (s.metrics?.timeTo5x) {
      timeTo5xSum += s.metrics.timeTo5x / (1000 * 60);
      timeTo5xCount++;
    }
    if (s.metrics?.timeTo10x) {
      timeTo10xSum += s.metrics.timeTo10x / (1000 * 60);
      timeTo10xCount++;
    }

    // Streak Analysis
    if (currentStreak > 0) {
      if (streakType === 'loss') {
        if (currentStreak >= 1) {
          stats.streakAnalysis.after1Loss.count++;
          if (isWin) stats.streakAnalysis.after1Loss.winRate++;
        }
        if (currentStreak >= 2) {
          stats.streakAnalysis.after2Losses.count++;
          if (isWin) stats.streakAnalysis.after2Losses.winRate++;
        }
        if (currentStreak >= 3) {
          stats.streakAnalysis.after3Losses.count++;
          if (isWin) stats.streakAnalysis.after3Losses.winRate++;
        }
      } else {
        if (currentStreak >= 1) {
          stats.streakAnalysis.after1Win.count++;
          if (isWin) stats.streakAnalysis.after1Win.winRate++;
        }
        if (currentStreak >= 2) {
          stats.streakAnalysis.after2Wins.count++;
          if (isWin) stats.streakAnalysis.after2Wins.winRate++;
        }
        if (currentStreak >= 3) {
          stats.streakAnalysis.after3Wins.count++;
          if (isWin) stats.streakAnalysis.after3Wins.winRate++;
        }
      }
    }

    if (isWin) {
      currentStreak = currentStreak > 0 && streakType === 'win' ? currentStreak + 1 : 1;
      streakType = 'win';
    } else {
      currentStreak = currentStreak > 0 && streakType === 'loss' ? currentStreak + 1 : 1;
      streakType = 'loss';
    }

    // Token Age Preference (requires token creation timestamps; mark data only if available)
    const tokenCreatedAt = (s as any).tokenCreatedAt || (s as any).createdAt || null;
    if (tokenCreatedAt) {
      const ageMinutes = (s.detectedAt.getTime() - new Date(tokenCreatedAt).getTime()) / (1000 * 60);
      const aBucket = stats.tokenAgeBuckets.find(b => ageMinutes >= b.minMinutes && ageMinutes < b.maxMinutes);
      if (aBucket) {
        aBucket.count++;
        if (isWin) aBucket.wins++;
        aBucket.avgMult += mult;
        stats.tokenAgeHasData = true;
      }
    }

    // Liquidity vs Return
    const liquidity = firstSample?.liquidity || 0;
    if (liquidity > 0) {
      const lBucket = stats.liquidityBuckets.find(b => liquidity >= b.min && liquidity < b.max);
      if (lBucket) {
        lBucket.count++;
        if (isWin) lBucket.wins++;
        lBucket.avgMult += mult;
      }
    }
  }

  // Finalize averages and percentages
  stats.mcBuckets.forEach(b => {
    if (b.count > 0) {
      b.avgMult /= b.count;
      // Keep wins as count, winRate will be calculated in UI
    }
  });

  stats.volumeBuckets.forEach(b => {
    if (b.count > 0) {
      b.avgMult /= b.count;
    }
  });

  // Time of Day - convert wins to win rate
  stats.timeOfDay.forEach(h => {
    if (h.count > 0) {
      h.winRate = h.winRate / h.count;
      h.avgMult /= h.count;
    }
  });

  // Time of Day by Day
  stats.timeOfDayByDay.forEach(d => {
    d.hours.forEach(h => {
      if (h.count > 0) {
        h.winRate = h.winRate / h.count;
        h.avgMult /= h.count;
      }
    });
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
        avgMult: gStat.totalMult / gStat.count,
        avgEntryMc: gStat.entryMcCount ? gStat.totalEntryMc / gStat.entryMcCount : 0,
        avgAthMult: gStat.totalAthMult / gStat.count,
        avgTimeToAth: gStat.timeToAthCount ? gStat.totalTimeToAth / gStat.timeToAthCount : 0,
        moonRate: gStat.count ? gStat.moonCount / gStat.count : 0
      });
    }
  }
  stats.groupWinRates.sort((a, b) => b.winRate - a.winRate);

  // Rug Pull Ratio & Moonshot Probability (as percentages)
  if (stats.totalSignals > 0) {
    stats.rugPullRatio = stats.rugPullRatio / stats.totalSignals;
    stats.moonshotProbability = stats.moonshotProbability / stats.totalSignals;
  }

  stats.moonshotTimes = {
    timeTo2x: timeTo2xCount ? timeTo2xSum / timeTo2xCount : 0,
    timeTo5x: timeTo5xCount ? timeTo5xSum / timeTo5xCount : 0,
    timeTo10x: timeTo10xCount ? timeTo10xSum / timeTo10xCount : 0
  };

  // Streak Analysis - convert to win rates
  if (stats.streakAnalysis.after1Loss.count > 0) {
    stats.streakAnalysis.after1Loss.winRate /= stats.streakAnalysis.after1Loss.count;
  }
  if (stats.streakAnalysis.after2Losses.count > 0) {
    stats.streakAnalysis.after2Losses.winRate /= stats.streakAnalysis.after2Losses.count;
  }
  if (stats.streakAnalysis.after3Losses.count > 0) {
    stats.streakAnalysis.after3Losses.winRate /= stats.streakAnalysis.after3Losses.count;
  }
  if (stats.streakAnalysis.after1Win.count > 0) {
    stats.streakAnalysis.after1Win.winRate /= stats.streakAnalysis.after1Win.count;
  }
  if (stats.streakAnalysis.after2Wins.count > 0) {
    stats.streakAnalysis.after2Wins.winRate /= stats.streakAnalysis.after2Wins.count;
  }
  if (stats.streakAnalysis.after3Wins.count > 0) {
    stats.streakAnalysis.after3Wins.winRate /= stats.streakAnalysis.after3Wins.count;
  }

  // Token Age Preference
  stats.tokenAgeBuckets.forEach(b => {
    if (b.count > 0) {
      b.avgMult /= b.count;
    }
  });

  // Liquidity vs Return
  stats.liquidityBuckets.forEach(b => {
    if (b.count > 0) {
      b.avgMult /= b.count;
    }
  });

  stats.currentStreak = { type: streakType, count: currentStreak };

  return stats;
};
