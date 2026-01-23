import { subDays } from 'date-fns';
import { prisma } from '../../../db';
import { provider } from '../../../providers';
import { logger } from '../../../utils/logger';
import { UIHelper } from '../../../utils/ui';
import { BotContext } from '../../../types/bot';
import { LiveSignalsCache, CachedSignal } from './types';

// Cache prices for 5 minutes - filtering should be fast using cached prices
// Only refresh prices when cache is stale or user explicitly refreshes
const CACHE_TTL_MS = 1 * 60 * 1000; // 5 minutes

const formatCallerLabel = (sig: any) => {
  const user = sig.user?.username ? `@${sig.user.username}` : null;
  const group = sig.group?.name || (sig.group?.chatId ? `Chat ${sig.group.chatId}` : null);
  if (user && group) return `${user} (${group})`;
  return user || group || 'Unknown';
};

/**
 * EXACT SAME LOGIC AS TEST SCRIPT
 * Test script works, so this will work too.
 */
const buildCache = async (
  ctx: BotContext,
  timeframeCutoff: Date,
  timeframeLabel: string
): Promise<LiveSignalsCache> => {
  const ownerTelegramId = ctx.from?.id ? BigInt(ctx.from.id) : null;
  if (!ownerTelegramId) {
    throw new Error('Unable to identify user.');
  }

  const userGroups = await prisma.group.findMany({
    where: { owner: { userId: ownerTelegramId }, isActive: true },
    select: { id: true, chatId: true, type: true }
  });
  const ownedChatIds = userGroups.map((g: any) => g.chatId);
  const destinationGroupIds = userGroups.filter((g: any) => g.type === 'destination').map((g: any) => g.id);

  let forwardedSignalIds: number[] = [];
  if (destinationGroupIds.length > 0) {
    const forwarded = await prisma.forwardedSignal.findMany({
      where: { destGroupId: { in: destinationGroupIds.map((id: number) => BigInt(id)) } },
      select: { signalId: true }
    });
    forwardedSignalIds = forwarded.map((f: any) => f.signalId);
  }

  if (ownedChatIds.length === 0 && forwardedSignalIds.length === 0) {
    return { signals: [], fetchedAt: Date.now(), timeframe: timeframeLabel };
  }

  const signals = await prisma.signal.findMany({
    where: {
      detectedAt: { gte: timeframeCutoff },
      trackingStatus: { in: ['ACTIVE', 'ENTRY_PENDING'] },
      OR: [
        { chatId: { in: ownedChatIds } },
        { id: { in: forwardedSignalIds } }
      ]
    },
    include: {
      group: true,
      user: true,
      metrics: true
    }
  });

  if (signals.length === 0) {
    return { signals: [], fetchedAt: Date.now(), timeframe: timeframeLabel };
  }

  // CRITICAL: Deduplicate by mint BEFORE fetching prices to reduce API calls
  // Keep only one signal per mint (most recent detection), but track first and latest detection times
  const mintMap = new Map<string, typeof signals[0]>();
  const mintFirstDetected = new Map<string, Date>();
  const mintLatestDetected = new Map<string, Date>();
  
  for (const sig of signals) {
    const existing = mintMap.get(sig.mint);
    if (!existing || sig.detectedAt.getTime() > existing.detectedAt.getTime()) {
      mintMap.set(sig.mint, sig);
    }
    // Track first and latest detection times per mint
    const firstDetected = mintFirstDetected.get(sig.mint);
    const latestDetected = mintLatestDetected.get(sig.mint);
    if (!firstDetected || sig.detectedAt.getTime() < firstDetected.getTime()) {
      mintFirstDetected.set(sig.mint, sig.detectedAt);
    }
    if (!latestDetected || sig.detectedAt.getTime() > latestDetected.getTime()) {
      mintLatestDetected.set(sig.mint, sig.detectedAt);
    }
  }
  const uniqueSignals = Array.from(mintMap.values());
  logger.info(`[LiveSignals] Deduplicated ${signals.length} signals to ${uniqueSignals.length} unique mints`);

  // STEP 1: Get all unique mints (now already unique, but keep for clarity)
  const allMints = [...new Set(uniqueSignals.map(s => s.mint))];
  const { getMultipleTokenPrices } = await import('../../../providers/jupiter');
  
  logger.info(`[LiveSignals] Fetching prices for ${allMints.length} unique mints using price/v3 (batch)`);
  
  // STEP 2: Fetch prices using price/v3 (FASTEST - batch with comma-separated IDs)
  const priceMap = await getMultipleTokenPrices(allMints);
  
  const pricesFound = Object.values(priceMap).filter(p => p !== null && p > 0).length;
  logger.info(`[LiveSignals] Jupiter price/v3 returned ${pricesFound}/${allMints.length} prices`);
  
  // Log sample of what we got
  const sampleMints = allMints.slice(0, 5);
  sampleMints.forEach(mint => {
    const price = priceMap[mint];
    if (price !== null && price > 0) {
      logger.info(`[LiveSignals] ✅ Token ${mint.slice(0, 8)}...: price=$${price}`);
    }
  });
  
  // STEP 3: Calculate market caps from prices and entry supply
  const marketCapMap: Record<string, number | null> = {};
  
  // Initialize all as null
  allMints.forEach(mint => {
    marketCapMap[mint] = null;
  });
  
  // Calculate market cap from price * entrySupply for each signal
  uniqueSignals.forEach(sig => {
    const price = priceMap[sig.mint];
    const entrySupply = sig.entrySupply;
    
    if (price !== null && price > 0 && entrySupply !== null && entrySupply > 0) {
      marketCapMap[sig.mint] = price * entrySupply;
    }
  });

  const marketCapsFound = Object.values(marketCapMap).filter(m => m !== null && m > 0).length;
  logger.info(`[LiveSignals] Calculated ${marketCapsFound} market caps from prices and entry supply`);
  
  // CRITICAL: Log signals that will have N/A
  const signalsWithNoData = signals.filter(s => {
    const hasPrice = priceMap[s.mint] !== null && priceMap[s.mint]! > 0;
    const hasMc = marketCapMap[s.mint] !== null && marketCapMap[s.mint]! > 0;
    return !hasPrice && !hasMc;
  });
  if (signalsWithNoData.length > 0) {
    logger.warn(`[LiveSignals] ${signalsWithNoData.length} signals will show N/A (no price/mcap from Jupiter)`);
    const sample = signalsWithNoData.slice(0, 3);
    sample.forEach(s => {
      logger.warn(`[LiveSignals] No data for ${s.mint.slice(0, 8)}...: priceMap=${priceMap[s.mint]}, marketCapMap=${marketCapMap[s.mint]}`);
    });
  }

    // STEP 4: Calculate PnL for unique signals only (already deduplicated)
    const cachedSignals: CachedSignal[] = uniqueSignals.map(sig => {
      // Use entry data directly from DB
      const entryPrice = sig.entryPrice ?? null;
      const entryMc = sig.entryMarketCap ?? null;
      
      // Get current price and market cap DIRECTLY from Jupiter (EXACT SAME AS TEST)
      const currentPrice = priceMap[sig.mint] ?? null;
      const currentMc = marketCapMap[sig.mint] ?? null;
      
      // Calculate PnL (EXACT SAME AS TEST SCRIPT - lines 37-42)
      let pnl = -Infinity;
      if (currentPrice !== null && currentPrice > 0 && entryPrice !== null && entryPrice > 0) {
        pnl = ((currentPrice - entryPrice) / entryPrice) * 100;
      } else if (currentMc !== null && currentMc > 0 && entryMc !== null && entryMc > 0) {
        pnl = ((currentMc - entryMc) / entryMc) * 100;
      }
      
      // Store with first and latest detection times
      const firstDetectedAt = mintFirstDetected.get(sig.mint) || sig.detectedAt;
      const latestDetectedAt = mintLatestDetected.get(sig.mint) || sig.detectedAt;
      
      return {
        mint: sig.mint,
        symbol: sig.symbol || 'N/A',
        entryPrice: entryPrice ?? 0,
        entryMc: entryMc ?? 0,
        currentPrice: currentPrice ?? 0,
        currentMc: currentMc ?? 0,
        pnl,
        detectedAt: latestDetectedAt, // Latest mention time
        firstDetectedAt, // Creation time
        groupId: sig.groupId ?? null,
        groupName: sig.group?.name || '',
        userId: sig.userId ?? null,
        userName: sig.user?.username
          ? `@${sig.user.username}`
          : sig.user?.firstName || '',
        signalId: sig.id
      };
    });

  return {
    signals: cachedSignals,
    fetchedAt: Date.now(),
    timeframe: timeframeLabel
  };
};

export const handleLiveSignals = async (ctx: BotContext, forceRefresh = false) => {
  let loadingMsg: any = null;
  try {
    if (!ctx.session) (ctx as any).session = {};
    
    const liveFilters = ctx.session?.liveFilters || {};
    const timeframeLabel = (liveFilters as any).timeframe || '24H';
    const timeframeParsed = UIHelper.parseTimeframeInput(timeframeLabel);
    const timeframeCutoff = timeframeLabel === 'ALL'
      ? new Date(0)
      : (timeframeParsed ? new Date(Date.now() - timeframeParsed.ms) : subDays(new Date(), 1));

    const sortBy = (liveFilters as any).sortBy || 'activity';
    const minMult = liveFilters.minMult || 0;
    const onlyGainers = liveFilters.onlyGainers || false;
    const displayLimit = (liveFilters as any).expand ? 20 : 10;

    // Use cached prices if available and fresh - only rebuild if stale, timeframe changed, or forced refresh
    const cached = ctx.session.liveSignalsCache;
    const cacheFresh = !forceRefresh && 
      cached && 
      cached.timeframe === timeframeLabel && 
      Date.now() - cached.fetchedAt < CACHE_TTL_MS;
    
    // Log cache status for debugging
    if (cached) {
      logger.info(`[LiveSignals] Cache check: timeframe=${cached.timeframe} vs requested=${timeframeLabel}, age=${Date.now() - cached.fetchedAt}ms, fresh=${cacheFresh}`);
    }
    
    let cache: LiveSignalsCache;
    if (cacheFresh) {
      logger.info('[LiveSignals] Using cached prices - filtering will be fast');
      cache = cached;
      // No loading message needed - instant filtering
    } else {
      // Cache is stale or timeframe changed - rebuild
      if (cached && cached.timeframe !== timeframeLabel) {
        logger.info(`[LiveSignals] Timeframe changed from ${cached.timeframe} to ${timeframeLabel} - rebuilding cache`);
      } else if (cached && Date.now() - cached.fetchedAt >= CACHE_TTL_MS) {
        logger.info(`[LiveSignals] Cache expired (age: ${Date.now() - cached.fetchedAt}ms) - rebuilding`);
      } else if (forceRefresh) {
        logger.info('[LiveSignals] Force refresh requested - rebuilding cache');
      }
      // Show loading message only when rebuilding cache
      if (ctx.callbackQuery && ctx.callbackQuery.message) {
        loadingMsg = ctx.callbackQuery.message;
        try {
          await ctx.telegram.editMessageText(
            loadingMsg.chat.id,
            loadingMsg.message_id,
            undefined,
            '⏳ Loading live signals and calculating ATH...',
            { parse_mode: 'Markdown' }
          );
        } catch {}
      } else {
        loadingMsg = await ctx.reply('⏳ Loading live signals and calculating ATH...');
      }
      
      logger.info('[LiveSignals] Building fresh cache with real-time prices');
      cache = await buildCache(ctx, timeframeCutoff, timeframeLabel);
      ctx.session.liveSignalsCache = cache;
    }

    // Filter by gainers/multipliers - works with ANY timeframe including ALL
    let filtered = cache.signals.filter((c: CachedSignal) => {
      if (onlyGainers && c.pnl <= 0) return false;
      if (minMult > 0) {
        const requiredPnl = (minMult - 1) * 100;
        if (c.pnl < requiredPnl) return false;
      }
      return true;
    });

    logger.info(`[LiveSignals] After filtering: ${filtered.length}/${cache.signals.length} signals (sortBy=${sortBy}, minMult=${minMult}, onlyGainers=${onlyGainers})`);

    // Sort based on filter type - works with ANY timeframe including ALL
    if (minMult > 0) {
      // >2x / >5x: sort by newest creation (firstDetectedAt)
      filtered.sort((a: CachedSignal, b: CachedSignal) => b.firstDetectedAt.getTime() - a.firstDetectedAt.getTime());
      logger.info(`[LiveSignals] Sorted by newest (minMult filter)`);
    } else if (sortBy === 'pnl' || sortBy === 'trending') {
      // Highest PnL / Trending: separate valid and invalid, sort valid descending
      const valid = filtered.filter(c => isFinite(c.pnl) && c.pnl !== -Infinity);
      const invalid = filtered.filter(c => !isFinite(c.pnl) || c.pnl === -Infinity);
      valid.sort((a, b) => b.pnl - a.pnl); // Highest PnL first
      filtered = [...valid, ...invalid];
      logger.info(`[LiveSignals] Sorted by PnL: ${valid.length} valid, ${invalid.length} invalid`);
    } else if (sortBy === 'newest') {
      // Newest: sort by firstDetectedAt (creation time)
      filtered.sort((a: CachedSignal, b: CachedSignal) => b.firstDetectedAt.getTime() - a.firstDetectedAt.getTime());
      logger.info(`[LiveSignals] Sorted by newest (firstDetectedAt)`);
    } else {
      // Default (activity): aggregate by mint, show most recent per mint
      const mintMap = new Map<string, CachedSignal>();
      for (const sig of filtered) {
        const existing = mintMap.get(sig.mint);
        if (!existing || sig.detectedAt.getTime() > existing.detectedAt.getTime()) {
          mintMap.set(sig.mint, sig);
        }
      }
      filtered = Array.from(mintMap.values());
      filtered.sort((a: CachedSignal, b: CachedSignal) => b.detectedAt.getTime() - a.detectedAt.getTime());
      logger.info(`[LiveSignals] Sorted by activity (latest mention): ${filtered.length} unique mints`);
    }

    // Get top items
    const topItems = filtered.slice(0, displayLimit);

    // Fetch full signal data for ATH calculation
    const { enrichSignalMetrics } = await import('../../../analytics/metrics');
    const signalMap = new Map<number, any>();
    if (topItems.length > 0) {
      const signals = await prisma.signal.findMany({
        where: { id: { in: topItems.map(i => i.signalId) } },
        include: { metrics: true, priceSamples: { orderBy: { sampledAt: 'asc' } }, group: true, user: true }
      });
      for (const s of signals) signalMap.set(s.id, s);
    }

    // Calculate ATH for top items only - process in small batches with longer delays to avoid GeckoTerminal rate limits
    // CRITICAL: This uses GeckoTerminal OHLCV to calculate ATH, max drawdown, and time to ATH
    logger.info(`[LiveSignals] Starting ATH calculation for ${topItems.length} top items using GeckoTerminal OHLCV`);
    
    // Update loading message to show progress
    if (loadingMsg && topItems.length > 0) {
      try {
        await ctx.telegram.editMessageText(
          loadingMsg.chat.id,
          loadingMsg.message_id,
          undefined,
          `⏳ Calculating ATH for ${topItems.length} signals using GeckoTerminal...`,
          { parse_mode: 'Markdown' }
        );
      } catch {}
    }
    
    const BATCH_SIZE = 3; // Process 3 tokens at a time
    const DELAY_BETWEEN_BATCHES_MS = 3000; // 3 seconds between batches
    const DELAY_BETWEEN_ITEMS_MS = 1000; // 1 second between items in same batch
    
    const failedTokens: Array<{ item: CachedSignal; sig: any }> = [];
    let athCalculated = 0;
    
    // First pass: process in batches
    for (let i = 0; i < topItems.length; i += BATCH_SIZE) {
      const batch = topItems.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(topItems.length / BATCH_SIZE);
      logger.info(`[LiveSignals] Processing ATH batch ${batchNum}/${totalBatches} (${batch.length} tokens) using GeckoTerminal`);
      
      // Update loading message with progress
      if (loadingMsg && batchNum % 2 === 0) { // Update every 2 batches to avoid spam
        try {
          await ctx.telegram.editMessageText(
            loadingMsg.chat.id,
            loadingMsg.message_id,
            undefined,
            `⏳ Calculating ATH: ${athCalculated}/${topItems.length} complete (batch ${batchNum}/${totalBatches})...`,
            { parse_mode: 'Markdown' }
          );
        } catch {}
      }
      
      for (const item of batch) {
        const sig = signalMap.get(item.signalId);
        if (sig && item.currentPrice > 0) {
          // Ensure entry data is populated for enrichSignalMetrics
          if (!sig.entryMarketCap && item.entryMc > 0) sig.entryMarketCap = item.entryMc;
          if (!sig.entryPrice && item.entryPrice > 0) sig.entryPrice = item.entryPrice;
          if (!sig.entrySupply && sig.entryMarketCap && sig.entryPrice) {
            sig.entrySupply = sig.entryMarketCap / sig.entryPrice;
          }
          
          logger.info(`[LiveSignals] Calculating ATH for ${item.mint.slice(0, 8)}... using GeckoTerminal OHLCV`);
          try {
            await Promise.race([
              enrichSignalMetrics(sig, false, item.currentPrice),
              new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 15000))
            ]);
            athCalculated++;
            logger.info(`[LiveSignals] ✅ ATH calculated for ${item.mint.slice(0, 8)}... (${athCalculated}/${topItems.length})`);
            
            // Delay between items in same batch
            if (item !== batch[batch.length - 1]) {
              await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_ITEMS_MS));
            }
          } catch (err) {
            logger.warn(`[LiveSignals] ❌ ATH calculation failed for ${item.mint.slice(0, 8)}...: ${err}`);
            failedTokens.push({ item, sig });
          }
        } else {
          logger.debug(`[LiveSignals] Skipping ATH for ${item.mint.slice(0, 8)}... (no signal or price: sig=${!!sig}, price=${item.currentPrice})`);
        }
      }
      
      // Delay between batches (except after last batch)
      if (i + BATCH_SIZE < topItems.length) {
        await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES_MS));
      }
    }
    
    logger.info(`[LiveSignals] ATH calculation complete: ${athCalculated} succeeded, ${failedTokens.length} failed`);
    
    // Retry failed tokens with longer delays
    if (failedTokens.length > 0) {
      logger.info(`[LiveSignals] Retrying ${failedTokens.length} failed ATH calculations with longer delays`);
      const RETRY_DELAY_MS = 5000; // 5 seconds between retries
      let retrySuccess = 0;
      
      for (let i = 0; i < failedTokens.length; i++) {
        const { item, sig } = failedTokens[i];
        logger.debug(`[LiveSignals] Retrying ATH for ${item.mint.slice(0, 8)}... (attempt ${i + 1}/${failedTokens.length})`);
        try {
          await Promise.race([
            enrichSignalMetrics(sig, false, item.currentPrice),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 20000))
          ]);
          retrySuccess++;
          athCalculated++;
          logger.debug(`[LiveSignals] ✅ Retry successful for ${item.mint.slice(0, 8)}...`);
        } catch (err) {
          logger.warn(`[LiveSignals] ❌ Retry failed for ${item.mint.slice(0, 8)}...: ${err}`);
        }
        
        // Delay between retries (except after last one)
        if (i < failedTokens.length - 1) {
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
        }
      }
      logger.info(`[LiveSignals] Retry complete: ${retrySuccess}/${failedTokens.length} succeeded`);
    }
    
    // CRITICAL: Re-fetch signals to get updated metrics from DB (including ATH market cap)
    // This ensures we have the latest ATH data calculated by GeckoTerminal
    if (topItems.length > 0) {
      logger.info(`[LiveSignals] Re-fetching ${topItems.length} signals to get updated ATH metrics from DB`);
      const updatedSignals = await prisma.signal.findMany({
        where: { id: { in: topItems.map(i => i.signalId) } },
        include: { metrics: true, group: true, user: true }
      });
      // Update signalMap with fresh metrics
      for (const s of updatedSignals) {
        signalMap.set(s.id, s);
        // Log ATH data for debugging - show what's actually in the DB
        if (s.metrics) {
          logger.info(`[LiveSignals] Signal ${s.id} (${s.mint.slice(0, 8)}...): ATH=${s.metrics.athMultiple?.toFixed(2) || 'N/A'}x, ATH Price=${s.metrics.athPrice || 'N/A'}, ATH MC=${s.metrics.athMarketCap ? UIHelper.formatMarketCap(s.metrics.athMarketCap) : 'N/A'}, MaxDD=${s.metrics.maxDrawdown || 'N/A'}, TimeToAth=${s.metrics.timeToAth ? `${Math.floor(s.metrics.timeToAth / 60000)}m` : 'N/A'}, EntrySupply=${s.entrySupply || 'N/A'}, EntryMC=${s.entryMarketCap ? UIHelper.formatMarketCap(s.entryMarketCap) : 'N/A'}`);
        } else {
          logger.warn(`[LiveSignals] Signal ${s.id} (${s.mint.slice(0, 8)}...) has NO metrics after re-fetch!`);
        }
      }
      logger.info(`[LiveSignals] Re-fetched ${updatedSignals.length} signals with updated metrics (ready to display)`);
    }

    // CRITICAL: All ATH calculations are now complete - fetch metadata and build message
    logger.info(`[LiveSignals] All ATH calculations complete. Fetching token metadata and building display...`);

    // Fetch token info for display (symbol, audit, socials)
    const { getMultipleTokenInfo } = await import('../../../providers/jupiter');
    const topMints = topItems.map(item => item.mint);
    const topTokenInfoMap = await getMultipleTokenInfo(topMints);
    
    const metaMap = new Map<string, any>();
    topItems.forEach(item => {
      const info = topTokenInfoMap[item.mint];
      if (info) {
        metaMap.set(item.mint, {
          symbol: info.symbol,
          name: info.name,
          audit: info.audit,
          socialLinks: {
            twitter: info.twitter,
            telegram: info.telegram,
            website: info.website
          },
          tags: info.tags || []
        });
      }
    });

    // Build message (EXACT SAME DISPLAY LOGIC AS TEST)
    // All ATH calculations are complete, metrics are fresh from DB
    logger.info(`[LiveSignals] Building display message for ${topItems.length} items with fresh ATH metrics`);
    let message = UIHelper.header(`Live Signals (${filtered.length})`);
    if (topItems.length === 0) {
      message += '\nNo signals match your filters.';
    }


    for (const item of topItems) {
      const sig = signalMap.get(item.signalId);
      const meta = metaMap.get(item.mint);

      const displaySymbol = meta?.symbol || item.symbol || 'N/A';
      const callerLabel = sig ? formatCallerLabel(sig) : item.userName || item.groupName || 'Unknown';
      
      // Time displays: latest mention (detectedAt) and creation (firstDetectedAt)
      const latestMentionAgo = UIHelper.formatTimeAgo(item.detectedAt);
      const creationAgo = UIHelper.formatTimeAgo(item.firstDetectedAt);

      // Display raw Jupiter data
      const entryStr = item.entryMc > 0 ? UIHelper.formatMarketCap(item.entryMc) : '$0';
      const currentStr = item.currentMc > 0 
        ? UIHelper.formatMarketCap(item.currentMc) 
        : item.currentMc === 0 
          ? '$0' 
          : 'N/A';
      
      // PnL calculation
      const pnlStr = isFinite(item.pnl) ? UIHelper.formatPercent(item.pnl) : 'N/A';
      const icon = isFinite(item.pnl) ? (item.pnl >= 0 ? '🟢' : '🔴') : '❓';

      // ATH - use previous method: max of stored ATH and current multiple
      const athMult = sig?.metrics?.athMultiple || 0;
      const athPrice = sig?.metrics?.athPrice || 0;
      const storedAthMc = sig?.metrics?.athMarketCap || null;
      
      // Calculate ATH market cap - prioritize stored value from DB (calculated by GeckoTerminal)
      let athMc = storedAthMc && storedAthMc > 0 ? storedAthMc : 0;
      
      // If not stored, calculate from ATH price and supply
      if (athMc <= 0 && athPrice > 0) {
        if (sig?.entrySupply && sig.entrySupply > 0) {
          athMc = athPrice * sig.entrySupply;
        } else if (item.entryMc && item.entryPrice && item.entryPrice > 0) {
          // Calculate supply from entry data
          const estimatedSupply = item.entryMc / item.entryPrice;
          if (estimatedSupply > 0) {
            athMc = athPrice * estimatedSupply;
          }
        }
      }
      
      // Last fallback: use ATH multiple * entry market cap
      if (athMc <= 0 && athMult > 0 && item.entryMc && item.entryMc > 0) {
        athMc = item.entryMc * athMult;
      }
      
      // Log for debugging
      if (sig?.metrics) {
        logger.debug(`[LiveSignals] Display ATH for ${item.mint.slice(0, 8)}...: mult=${athMult.toFixed(2)}, price=${athPrice}, storedMc=${storedAthMc}, calculatedMc=${athMc}`);
      }
      
      const currentMult = isFinite(item.pnl) ? (item.pnl / 100) + 1 : 0;
      const effectiveAth = Math.max(athMult, currentMult);
      const athLabel = effectiveAth > 1.05
        ? `${effectiveAth.toFixed(1)}x ATH${athMc > 0 ? ` (${UIHelper.formatMarketCap(athMc)})` : ''}`
        : 'ATH N/A';

      // Max drawdown (from metrics, negative % or 0 if no drawdown)
      const maxDrawdown = sig?.metrics?.maxDrawdown ?? null;
      let drawdownStr = 'N/A';
      let drawdownMcStr = '';
      
      if (maxDrawdown !== null && maxDrawdown !== undefined) {
        if (maxDrawdown < 0) {
          drawdownStr = UIHelper.formatPercent(maxDrawdown);
          // Calculate max drawdown market cap on-the-fly
          // Since maxDrawdownMarketCap is not in DB schema, calculate from maxDrawdown percentage
          if (item.entryMc && item.entryMc > 0 && maxDrawdown < 0) {
            // maxDrawdown is negative %, so: drawdownMc = entryMc * (1 + maxDrawdown/100)
            // Example: -20% drawdown means 80% of entry = entryMc * 0.8
            const ddMc = item.entryMc * (1 + (maxDrawdown / 100));
            if (ddMc > 0) {
              drawdownMcStr = ` (${UIHelper.formatMarketCap(ddMc)})`;
            }
          }
        } else if (maxDrawdown === 0) {
          drawdownStr = '0%'; // No drawdown
        } else {
          drawdownStr = 'N/A'; // Invalid positive value
        }
      }
      
      // Log for debugging
      if (sig?.metrics) {
        logger.debug(`[LiveSignals] Display DD for ${item.mint.slice(0, 8)}...: maxDD=${maxDrawdown}, str=${drawdownStr}${drawdownMcStr}`);
      }

      // Time to ATH (from metrics, in ms, convert to readable format)
      const timeToAthMs = sig?.metrics?.timeToAth || null;
      let timeToAthStr = 'N/A';
      if (timeToAthMs !== null && timeToAthMs !== undefined && timeToAthMs > 0) {
        const minutes = Math.floor(timeToAthMs / 60000);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);
        if (days > 0) {
          timeToAthStr = `${days}d ${hours % 24}h`;
        } else if (hours > 0) {
          timeToAthStr = `${hours}h ${minutes % 60}m`;
        } else if (minutes > 0) {
          timeToAthStr = `${minutes}m`;
        } else {
          timeToAthStr = '<1m';
        }
      }
      
      // Log for debugging
      if (sig?.metrics) {
        logger.debug(`[LiveSignals] Display timeToAth for ${item.mint.slice(0, 8)}...: ${timeToAthMs}ms = ${timeToAthStr}`);
      }
      
      // Time from max drawdown to ATH - calculate on-the-fly since not in DB schema
      // If we have timeToAth and maxDrawdown occurred, we can estimate
      let timeFromDrawdownToAthStr = 'N/A';
      
      // If we have timeToAth and maxDrawdown < 0, we can show time to ATH as recovery time
      // (This is an approximation - actual drawdown-to-ATH time would need to be stored)
      if (timeToAthMs !== null && timeToAthMs > 0 && maxDrawdown !== null && maxDrawdown < 0) {
        // For now, show time to ATH as the recovery window
        // In the future, we'd need to store maxDrawdownAt timestamp in DB
        const minutes = Math.floor(timeToAthMs / 60000);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);
        if (days > 0) {
          timeFromDrawdownToAthStr = `${days}d ${hours % 24}h`;
        } else if (hours > 0) {
          timeFromDrawdownToAthStr = `${hours}h ${minutes % 60}m`;
        } else if (minutes > 0) {
          timeFromDrawdownToAthStr = `${minutes}m`;
        } else {
          timeFromDrawdownToAthStr = '<1m';
        }
      }

      const dexPaid = (meta?.tags || []).some((t: string) => t.toLowerCase().includes('dex')) ? '✅' : '❔';
      const migrated = (meta?.audit?.devMigrations || 0) > 0 ? '✅' : '❔';
      const hasTeam = meta?.audit?.devBalancePercentage !== undefined ? (meta.audit.devBalancePercentage < 5 ? '✅' : '❌') : '❔';
      const hasX = meta?.socialLinks?.twitter ? '✅' : '❔';

      message += `\n${icon} *${displaySymbol}* (\`${item.mint.slice(0,4)}..${item.mint.slice(-4)}\`)\n`;
      message += `💰 *Entry:* ${entryStr} ➔ *Now:* ${currentStr} (*${pnlStr}*)\n`;
      message += `📈 *ATH:* ${athLabel} | 📉 *Max DD:* ${drawdownStr}${drawdownMcStr} | ⏱️ *To ATH:* ${timeToAthStr}\n`;
      if (timeFromDrawdownToAthStr !== 'N/A') {
        message += `📊 *DD→ATH:* ${timeFromDrawdownToAthStr}\n`;
      }
      message += `🍬 *Dex:* ${dexPaid} | 📦 *Mig:* ${migrated} | 👥 *Team:* ${hasTeam} | 𝕏 *X:* ${hasX}\n`;
      message += `⏱️ *Latest:* ${latestMentionAgo} | 🆕 *Created:* ${creationAgo} | 👤 *${callerLabel}*\n`;
      message += UIHelper.separator('LIGHT');
    }

    const filters = [
      [
        { text: '🔥 Trending', callback_data: 'live_sort:trending' },
        { text: '🆕 Newest', callback_data: 'live_sort:newest' },
        { text: '💰 Highest PnL', callback_data: 'live_sort:pnl' }
      ],
      [
        { text: minMult === 2 ? '✅ > 2x' : '🚀 > 2x', callback_data: 'live_filter:2x' },
        { text: minMult === 5 ? '✅ > 5x' : '🌕 > 5x', callback_data: 'live_filter:5x' },
        { text: onlyGainers ? '✅ Gainers' : '🟢 Gainers', callback_data: 'live_filter:gainers' }
      ],
      [
        { text: timeframeLabel === '1H' ? '✅ 1H' : '1H', callback_data: 'live_time:1H' },
        { text: timeframeLabel === '6H' ? '✅ 6H' : '6H', callback_data: 'live_time:6H' },
        { text: timeframeLabel === '24H' ? '✅ 24H' : '24H', callback_data: 'live_time:24H' },
        { text: timeframeLabel === '7D' ? '✅ 7D' : '7D', callback_data: 'live_time:7D' },
        { text: timeframeLabel === 'ALL' ? '✅ ALL' : 'ALL', callback_data: 'live_time:ALL' }
      ],
      [
        { text: '⚙️ Custom', callback_data: 'live_time:custom' }
      ],
      [
        { text: '🔄 Refresh', callback_data: 'live_signals' },
        { text: '❌ Close', callback_data: 'delete_msg' }
      ]
    ];

    if (loadingMsg && loadingMsg.chat && loadingMsg.message_id) {
      try {
        await ctx.telegram.editMessageText(loadingMsg.chat.id, loadingMsg.message_id, undefined, message, {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: filters }
        });
      } catch {
        await ctx.reply(message, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: filters } });
      }
    } else {
      await ctx.reply(message, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: filters } });
    }
  } catch (error) {
    logger.error('Error in live signals:', error);
    if (loadingMsg && loadingMsg.chat && loadingMsg.message_id) {
      try {
        await ctx.telegram.editMessageText(loadingMsg.chat.id, loadingMsg.message_id, undefined, '❌ Error loading signals.');
      } catch {}
    }
  }
};

