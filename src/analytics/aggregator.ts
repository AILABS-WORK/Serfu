import { prisma } from '../db';
import { Signal, SignalMetric } from '../generated/client';
import { logger } from '../utils/logger';
import { getMultipleTokenPrices } from '../providers/jupiter';
import { getEntryTime } from './metricsUtils';

export interface EntityStats {
  id: number;
  name: string;
  totalSignals: number;
  avgMultiple: number; // e.g. 3.5x
  winRate: number; // % of signals >= WIN_MULTIPLE
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
  consecutiveWins: number; // Current streak of >= WIN_MULTIPLE calls
  followThrough: number; // % of calls that are >= WIN_MULTIPLE
  
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

const WIN_MULTIPLE = 1.4;

const buildEntryTimeFilter = (since: Date) => ({
  OR: [
    { entryPriceAt: { gte: since } },
    { entryPriceAt: null, detectedAt: { gte: since } }
  ]
});

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
      if (m >= WIN_MULTIPLE) consecutiveWins++;
      else break;
  }

  for (const s of signals) {
    // Cache-only metrics: skip signals without metrics
    if (!s.metrics) continue;

    let mult = s.metrics.athMultiple || 0;
    let dd = s.metrics.maxDrawdown || 0;
    let athAt: Date | null = s.metrics.athAt || null;
    multiples.push(mult);
    totalMult += mult;
    if (mult >= WIN_MULTIPLE) wins++;
    if (mult > 5) wins5x++;
    if (mult > 10) wins10x++;
    if (mult > maxMult) {
      maxMult = mult;
      bestSignal = s;
    }

    // Rug Rate: ATH < 0.5 OR Drawdown <= -90%
    if (mult < 0.5 || dd <= -90) rugCount++;

    // Drawdown (stored as negative decimal e.g. -0.4)
    totalDrawdown += dd;

    // Time to ATH (use calculated athAt if available)
    const entryTime = getEntryTime(s);
    if (athAt && entryTime) {
      const diffMs = new Date(athAt).getTime() - entryTime.getTime();
      if (diffMs > 0) {
        totalTime += diffMs / (1000 * 60); // minutes
        timeCount++;
      }
    }
    
    // V2 Time Metrics (from metrics if available, otherwise skip for accuracy)
    const time2x = s.metrics?.timeTo2x;
    if (time2x) {
        timeTo2xSum += time2x / (1000 * 60);
        timeTo2xCount++;
    }

    const time3x = s.metrics?.timeTo3x;
    if (time3x) {
        timeTo3xSum += time3x / (1000 * 60);
        timeTo3xCount++;
    }

    const time5x = s.metrics?.timeTo5x;
    if (time5x) {
        timeTo5xSum += time5x / (1000 * 60);
        timeTo5xCount++;
    }

    const time10x = s.metrics?.timeTo10x;
    if (time10x) {
        timeTo10xSum += time10x / (1000 * 60);
        timeTo10xCount++;
    }

    // Stagnation Time and Drawdown Duration (from new schema fields)
    if (s.metrics?.stagnationTime) {
        stagnationTimeSum += s.metrics.stagnationTime / (1000 * 60);
        stagnationTimeCount++;
    }

    if (s.metrics?.drawdownDuration) {
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
    const entryMc = s.entryMarketCap || s.priceSamples?.[0]?.marketCap;
    if (entryMc) {
        totalMcap += entryMc;
        mcapCount++;
    }
    const supply =
      s.entrySupply ||
      (s.entryMarketCap && s.entryPrice ? s.entryMarketCap / s.entryPrice : null);
    const athMcap =
      s.metrics?.athMarketCap ||
      (s.metrics?.athPrice && supply ? s.metrics.athPrice * supply : null) ||
      (mult > 0 && s.entryMarketCap ? s.entryMarketCap * mult : null); // Use calculated ATH if metrics missing
    if (athMcap) {
        totalAthMcap += athMcap;
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
  const drawdownPenalty = Math.abs(avgDrawdown) / 100;
  const score = (winRate * 40) + (winRate5x * 20) + (avgMultiple * 5) - (drawdownPenalty * 50) - (rugRate * 50);

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

export const getGroupStats = async (groupId: number, timeframe: TimeFrame, chain: 'solana' | 'bsc' | 'both' = 'both'): Promise<EntityStats | null> => {
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
  // OPTIMIZED: Include signals even if metrics missing (will use real-time calculation)
  // But prefer cached metrics when available (< 5 min old)
  const now = Date.now();
  const signals = await prisma.signal.findMany({
    where: {
      groupId: { in: groupIds },
      ...buildEntryTimeFilter(since),
      ...(chain !== 'both' ? { chain } : {})
    },
    include: { 
      metrics: true, 
      priceSamples: { orderBy: { sampledAt: 'asc' }, take: 1 } 
    }
  });

  // Cache-only: do not enrich here (background job updates metrics)

  // Calculate stats using fully enriched signals
  const stats = calculateStats(signals);
  stats.id = group.id;
  stats.name = group.name || `Group ${group.chatId}`;
  
  return stats;
};

export const getUserStats = async (userId: number, timeframe: TimeFrame, chain: 'solana' | 'bsc' | 'both' = 'both'): Promise<EntityStats | null> => {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return null;

  const since = getDateFilter(timeframe);
  // OPTIMIZED: Include signals even if metrics missing (will use real-time calculation)
  const signals = await prisma.signal.findMany({
    where: {
      userId,
      ...buildEntryTimeFilter(since),
      ...(chain !== 'both' ? { chain } : {})
    },
    include: { metrics: true, priceSamples: { orderBy: { sampledAt: 'asc' }, take: 1 } }
  });

  // Cache-only: do not enrich here (background job updates metrics)

  const stats = calculateStats(signals);
  stats.id = user.id;
  stats.name = user.username || user.firstName || 'Unknown User';

  return stats;
};

export const getLeaderboard = async (
  type: 'GROUP' | 'USER', 
  timeframe: TimeFrame, 
  sortBy: 'PNL' | 'WINRATE' | 'SCORE' = 'SCORE',
  limit = 10,
  ownerTelegramId?: bigint,
  chain: 'solana' | 'bsc' | 'both' = 'both'
): Promise<EntityStats[]> => {
  const since = getDateFilter(timeframe);
  
  let scopeFilter: any = {};
  if (ownerTelegramId) {
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
    scopeFilter = {
        OR: [
            { chatId: { in: ownedChatIds } },
            { id: { in: forwardedSignalIds } }
        ]
    };
  }

  // 1. Fetch all signals in window (cache-only)
  const signals = await prisma.signal.findMany({
    where: {
      ...buildEntryTimeFilter(since),
      ...scopeFilter,
      ...(chain !== 'both' ? { chain } : {})
    },
    include: { metrics: true, group: true, user: true, priceSamples: { orderBy: { sampledAt: 'asc' }, take: 1 } }
  });
  
  // Cache-only: only use signals with stored metrics
  const validSignals = signals.filter(s => !!s.metrics);

  // 2. Group by Entity (Deduplicating Groups by ChatId)
  const entityMap = new Map<string, typeof validSignals>();
  const idMap = new Map<string, number>(); // Map Key -> Representative ID
  const nameMap = new Map<string, string>();

  // Cache-only: no enrichment here

  for (const s of validSignals) {
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
  limit = 10,
  ownerTelegramId?: bigint,
  chain: 'solana' | 'bsc' | 'both' = 'both'
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
  timeToAth: number | null,
  maxDrawdown: number | null,
  timeFromDdToAth: number | null, // minutes
  signalAge: number // hours since detection
}>> => {
  const since = getDateFilter(timeframe);
  
  let scopeFilter: any = {};
  if (ownerTelegramId) {
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
    scopeFilter = {
        OR: [
            { chatId: { in: ownedChatIds } },
            { id: { in: forwardedSignalIds } }
        ]
    };
  }

  // Include all signals in timeframe so ATH can be computed for ranking
  const signals = await prisma.signal.findMany({
    where: {
      ...buildEntryTimeFilter(since),
      ...scopeFilter,
      ...(chain !== 'both' ? { chain } : {}),
    },
    include: { 
      metrics: true, 
      group: true, 
      user: true,
      priceSamples: { orderBy: { sampledAt: 'asc' }, take: 1 } // Add for entryMarketCap fallback
    }
  });
  
  // Cache-only: filter out signals missing metrics, and log if any missing
  const missingMetricsCount = signals.filter(s => !s.metrics).length;
  if (missingMetricsCount > 0) {
    logger.info(`[SignalLeaderboard] ${missingMetricsCount}/${signals.length} signals missing metrics (background job will fill)`);
  }
  const signalsWithMetrics = signals.filter(s => !!s.metrics);
  
  // DEDUPLICATE BY MINT: Keep only the EARLIEST call for each token
  // This ensures each token appears only once (first caller wins)
  const mintMap = new Map<string, typeof signalsWithMetrics[0]>();
  for (const s of signalsWithMetrics) {
    const entryTime = getEntryTime(s);
    const existing = mintMap.get(s.mint);
    if (!existing) {
      mintMap.set(s.mint, s);
    } else {
      // Keep the earliest signal (first caller)
      const existingEntryTime = getEntryTime(existing);
      if (entryTime && existingEntryTime && entryTime.getTime() < existingEntryTime.getTime()) {
        mintMap.set(s.mint, s);
      }
    }
  }
  const uniqueSignals = Array.from(mintMap.values());
  logger.info(`[SignalLeaderboard] Deduplicated ${signalsWithMetrics.length} signals to ${uniqueSignals.length} unique mints`);
  
  // Sort by ATH (highest first)
  uniqueSignals.sort((a, b) => {
    const aAth = a.metrics?.athMultiple || 0;
    const bAth = b.metrics?.athMultiple || 0;
    return bAth - aAth;
  });
  
  // Take top limit after sorting
  const topSignals = uniqueSignals.slice(0, limit);
  const topMints = [...new Set(topSignals.map(s => s.mint))];
  const currentPriceMap = await getMultipleTokenPrices(topMints);

  return topSignals.map(s => {
    // Use enriched metrics
    const currentPrice = currentPriceMap[s.mint] ?? s.metrics?.currentPrice ?? null;
    const currentMc = currentPrice && s.entrySupply ? currentPrice * s.entrySupply : (s.metrics?.currentMarketCap || null);
    const athMarketCap = s.metrics?.athMarketCap || null;
    
    // Calculate time to ATH in minutes (with validation to prevent negative values)
    let timeToAth: number | null = null;
    if (s.metrics?.timeToAth !== null && s.metrics?.timeToAth !== undefined) {
      // timeToAth is stored in milliseconds, convert to minutes
      const timeMs = s.metrics.timeToAth;
      if (timeMs > 0) {
        timeToAth = timeMs / (1000 * 60);
      }
    } else if (s.metrics?.athAt) {
      const entryTime = getEntryTime(s);
      const diffMs = entryTime ? s.metrics.athAt.getTime() - entryTime.getTime() : 0;
      if (diffMs > 0) {
        timeToAth = diffMs / (1000 * 60);
      } else {
        logger.warn(`Negative timeToAth for signal ${s.id}: athAt=${s.metrics.athAt}, entryTime=${entryTime}`);
      }
    }
    
    // Ensure entryMarketCap has fallback from first priceSample
    const entryMc = s.entryMarketCap || s.priceSamples?.[0]?.marketCap || null;
    
    // Max Drawdown
    const maxDrawdown = s.metrics?.maxDrawdown ?? null;
    
    // Time from drawdown to ATH (minutes)
    let timeFromDdToAth: number | null = null;
    if (s.metrics?.athAt && s.metrics?.minLowAt) {
      const diffMs = s.metrics.athAt.getTime() - s.metrics.minLowAt.getTime();
      if (diffMs > 0) {
        timeFromDdToAth = diffMs / (1000 * 60);
      }
    }
    
    // Signal age in hours
    const entryTime = getEntryTime(s) ?? s.detectedAt;
    const signalAge = (Date.now() - entryTime.getTime()) / (1000 * 60 * 60);
    
    return {
      id: s.id,
      mint: s.mint,
      symbol: s.symbol || 'Unknown',
      athMultiple: s.metrics?.athMultiple || 0,
      sourceName: s.user?.username || s.group?.name || 'Unknown',
      detectedAt: s.detectedAt,
      entryMarketCap: entryMc, // Use fallback from priceSamples if needed
      athMarketCap,
      currentMarketCap: currentMc,
      timeToAth,
      maxDrawdown,
      timeFromDdToAth,
      signalAge
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
    moonshotCounts: { gt2x: number; gt3x: number; gt4x: number; gt5x: number; gt10x: number; gt15x: number; gt20x: number; gt50x: number; gt100x: number };
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
  confluenceBuckets: Array<{
    label: string;
    min: number;
    max: number;
    count: number;
    wins: number;
    avgMult: number;
  }>;
  currentStreak: { type: 'win' | 'loss'; count: number };
  totalSignals: number;
  rawSignals: number;
  metricsSignals: number;
  // NEW: ATH Return Distribution
  returnBuckets: Array<{
    label: string;
    min: number;
    max: number;
    count: number;
    avgEntryMc: number;
  }>;
  avgReturn: number;
  medianReturn: number;
  stdDevReturn: number;
  totalUniqueMints: number;
}

export const getDistributionStats = async (
  ownerTelegramId: bigint, 
  timeframe: TimeFrame,
  target?: { type: 'OVERALL' | 'GROUP' | 'USER'; id?: number },
  chain: 'solana' | 'bsc' | 'both' = 'both'
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
      ],
      ...(chain !== 'both' ? { chain } : {})
  };

  if (targetType === 'GROUP' && target?.id && allowedGroupIds.has(target.id)) {
    scopeFilter = { groupId: target.id };
  } else if (targetType === 'USER' && target?.id) {
    scopeFilter = { userId: target.id };
  }

  // Cache-only: include signals, but skip those missing metrics during computation
  const signals = await prisma.signal.findMany({
    where: {
      ...buildEntryTimeFilter(since),
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

  logger.info(`[DistributionStats] Processing ${signals.length} total signals`);
  
  // CRITICAL: Deduplicate by mint - only keep FIRST detection per token
  // This ensures distributions reflect unique token performance, not duplicate mentions
  const mintMap = new Map<string, typeof signals[0]>();
  for (const s of signals) {
    const entryTime = getEntryTime(s);
    const existing = mintMap.get(s.mint);
    if (!existing) {
      mintMap.set(s.mint, s);
    } else {
      // Keep the earliest signal (first caller)
      const existingEntryTime = getEntryTime(existing);
      if (entryTime && existingEntryTime && entryTime.getTime() < existingEntryTime.getTime()) {
        mintMap.set(s.mint, s);
      }
    }
  }
  const uniqueSignals = Array.from(mintMap.values());
  logger.info(`[DistributionStats] Deduplicated ${signals.length} signals to ${uniqueSignals.length} unique mints`);
  
  const signalsWithMetrics = uniqueSignals.filter(s =>
    !!s.metrics &&
    (s.metrics.athMultiple ?? 0) > 0 &&
    (s.metrics.athPrice ?? 0) > 0
  );
  const missingMetricsCount = uniqueSignals.length - signalsWithMetrics.length;
  if (missingMetricsCount > 0) {
    logger.info(`[DistributionStats] ${missingMetricsCount}/${uniqueSignals.length} unique mints missing ATH metrics (skipping for distributions)`);
  }

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
    moonshotCounts: { gt2x: 0, gt3x: 0, gt4x: 0, gt5x: 0, gt10x: 0, gt15x: 0, gt20x: 0, gt50x: 0, gt100x: 0 },
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
    confluenceBuckets: [
      { label: '1 source', min: 1, max: 1, count: 0, wins: 0, avgMult: 0 },
      { label: '2 sources', min: 2, max: 2, count: 0, wins: 0, avgMult: 0 },
      { label: '3-4 sources', min: 3, max: 4, count: 0, wins: 0, avgMult: 0 },
      { label: '5+ sources', min: 5, max: 1000, count: 0, wins: 0, avgMult: 0 }
    ],
    currentStreak: { type: 'loss', count: 0 },
    totalSignals: signalsWithMetrics.length,
    rawSignals: uniqueSignals.length, // Unique mints only
    metricsSignals: signalsWithMetrics.length,
    // NEW: ATH Return Distribution buckets
    returnBuckets: [
      { label: '<0.5x', min: 0, max: 0.5, count: 0, avgEntryMc: 0 },
      { label: '0.5-1x', min: 0.5, max: 1, count: 0, avgEntryMc: 0 },
      { label: '1-1.5x', min: 1, max: 1.5, count: 0, avgEntryMc: 0 },
      { label: '1.5-2x', min: 1.5, max: 2, count: 0, avgEntryMc: 0 },
      { label: '2-3x', min: 2, max: 3, count: 0, avgEntryMc: 0 },
      { label: '3-5x', min: 3, max: 5, count: 0, avgEntryMc: 0 },
      { label: '5-10x', min: 5, max: 10, count: 0, avgEntryMc: 0 },
      { label: '10-25x', min: 10, max: 25, count: 0, avgEntryMc: 0 },
      { label: '25-50x', min: 25, max: 50, count: 0, avgEntryMc: 0 },
      { label: '50-100x', min: 50, max: 100, count: 0, avgEntryMc: 0 },
      { label: '100x+', min: 100, max: 1000000, count: 0, avgEntryMc: 0 },
    ],
    avgReturn: 0,
    medianReturn: 0,
    stdDevReturn: 0,
    totalUniqueMints: uniqueSignals.length
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
  const sortedSignals = [...signalsWithMetrics].sort((a, b) => {
    const aTime = getEntryTime(a)?.getTime() ?? a.detectedAt.getTime();
    const bTime = getEntryTime(b)?.getTime() ?? b.detectedAt.getTime();
    return aTime - bTime;
  });
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

  // For return distribution statistics
  const allMultiples: number[] = [];

  const confluenceMap = new Map<string, { groups: Set<number>; maxMult: number }>();
  for (const s of sortedSignals) {
    const mult = s.metrics?.athMultiple || 0;
    // Confluence: count distinct groups per mint and keep max multiple
    if (s.mint) {
      const entry = confluenceMap.get(s.mint) || { groups: new Set<number>(), maxMult: 0 };
      if (s.groupId) entry.groups.add(s.groupId);
      else entry.groups.add(0);
      if (mult > entry.maxMult) entry.maxMult = mult;
      confluenceMap.set(s.mint, entry);
    }
    const entryMc = s.entryMarketCap || s.priceSamples?.[0]?.marketCap || 0;
    const maxDrawdown = s.metrics?.maxDrawdown || 0;
    const isWin = mult >= WIN_MULTIPLE;
    const isRug = mult < 0.5 || maxDrawdown <= -90;
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
    const date = getEntryTime(s) ?? s.detectedAt;
    const hour = date.getUTCHours();
    stats.timeOfDay[hour].count++;
    if (isWin) stats.timeOfDay[hour].winRate++;
    stats.timeOfDay[hour].avgMult += mult;

    // Day of Week Analysis
    const dayIndex = date.getUTCDay(); // 0=Sun, 1=Mon, etc.
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
    // Rug = ATH < 0.5x (loss > 50%) OR Max Drawdown > 90%
    // Enriched metrics ensure athMultiple and maxDrawdown are accurate
    if (isRug) stats.rugPullRatio++;

    // Moonshot Probability - comprehensive buckets
    // Enriched metrics ensure athMultiple is accurate (using minute/hour/day candles)
    if (mult > 2) stats.moonshotCounts.gt2x++;
    if (mult > 3) stats.moonshotCounts.gt3x++;
    if (mult > 4) stats.moonshotCounts.gt4x++;
    if (mult > 5) stats.moonshotCounts.gt5x++;
    if (mult > 10) stats.moonshotCounts.gt10x++;
    if (mult > 15) stats.moonshotCounts.gt15x++;
    if (mult > 20) stats.moonshotCounts.gt20x++;
    if (mult > 50) stats.moonshotCounts.gt50x++;
    if (mult > 100) stats.moonshotCounts.gt100x++;
    if (isMoonshot) stats.moonshotProbability++;

    // NEW: ATH Return Distribution Buckets
    const rBucket = stats.returnBuckets.find(b => mult >= b.min && mult < b.max);
    if (rBucket) {
      rBucket.count++;
      if (entryMc > 0) rBucket.avgEntryMc += entryMc;
    }
    allMultiples.push(mult);

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
      const entryTime = getEntryTime(s) ?? s.detectedAt;
      const ageMinutes = (entryTime.getTime() - new Date(tokenCreatedAt).getTime()) / (1000 * 60);
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

  // Confluence buckets
  for (const entry of confluenceMap.values()) {
    const groupCount = entry.groups.size;
    const bucket = stats.confluenceBuckets.find(b => groupCount >= b.min && groupCount <= b.max);
    if (bucket) {
      bucket.count++;
      if (entry.maxMult >= WIN_MULTIPLE) bucket.wins++;
      bucket.avgMult += entry.maxMult;
    }
  }
  stats.confluenceBuckets.forEach(b => {
    if (b.count > 0) b.avgMult /= b.count;
  });

  stats.currentStreak = { type: streakType, count: currentStreak };

  // Finalize Return Distribution Statistics
  stats.returnBuckets.forEach(b => {
    if (b.count > 0) {
      b.avgEntryMc /= b.count;
    }
  });

  // Calculate avg, median, stddev of returns
  if (allMultiples.length > 0) {
    stats.avgReturn = allMultiples.reduce((a, b) => a + b, 0) / allMultiples.length;
    
    // Median
    const sorted = [...allMultiples].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    stats.medianReturn = sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    
    // Standard Deviation
    const squaredDiffs = allMultiples.map(x => Math.pow(x - stats.avgReturn, 2));
    stats.stdDevReturn = Math.sqrt(squaredDiffs.reduce((a, b) => a + b, 0) / allMultiples.length);
  }

  return stats;
};
