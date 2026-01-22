import { subDays } from 'date-fns';
import { prisma } from '../../../db';
import { provider } from '../../../providers';
import { logger } from '../../../utils/logger';
import { UIHelper } from '../../../utils/ui';
import { BotContext } from '../../../types/bot';
import { LiveSignalsCache, CachedSignal } from './types';

// NO CACHE - Always fetch fresh prices on every click
const CACHE_TTL_MS = 0;

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

  // STEP 1: Get all unique mints (EXACT SAME AS TEST)
  const allMints = [...new Set(signals.map(s => s.mint))];
  const { getMultipleTokenInfo } = await import('../../../providers/jupiter');
  
  logger.info(`[LiveSignals] Fetching token info for ${allMints.length} unique mints`);
  
  // STEP 2: Fetch token info (EXACT SAME AS TEST)
  const tokenInfoMap = await getMultipleTokenInfo(allMints);
  
  // CRITICAL DEBUG: Log what we got from Jupiter
  const tokensWithData = Object.entries(tokenInfoMap).filter(([_, info]) => info !== null);
  logger.info(`[LiveSignals] Jupiter returned data for ${tokensWithData.length}/${allMints.length} tokens`);
  
  // Log sample of what we got
  if (tokensWithData.length > 0) {
    const sample = tokensWithData.slice(0, 3);
    sample.forEach(([mint, info]) => {
      logger.info(`[LiveSignals] Sample token ${mint.slice(0, 8)}...: price=$${info?.usdPrice}, mcap=$${info?.mcap}`);
    });
  }
  
  // STEP 3: Extract prices and market caps (EXACT SAME AS TEST)
  const priceMap: Record<string, number | null> = {};
  const marketCapMap: Record<string, number | null> = {};
  
  // Initialize all as null (EXACT SAME AS TEST)
  allMints.forEach(mint => {
    priceMap[mint] = null;
    marketCapMap[mint] = null;
  });
  
  // Extract from tokenInfoMap (EXACT SAME AS TEST)
  Object.entries(tokenInfoMap).forEach(([mint, info]) => {
    if (info) {
      priceMap[mint] = info.usdPrice ?? null;
      marketCapMap[mint] = info.mcap ?? null;
      // Log if we got null values
      if (info.usdPrice === null || info.usdPrice === undefined) {
        logger.warn(`[LiveSignals] Token ${mint.slice(0, 8)}... has null/undefined usdPrice`);
      }
      if (info.mcap === null || info.mcap === undefined) {
        logger.warn(`[LiveSignals] Token ${mint.slice(0, 8)}... has null/undefined mcap`);
      }
    } else {
      logger.warn(`[LiveSignals] Token ${mint.slice(0, 8)}... has null info in tokenInfoMap`);
    }
  });
  
  const pricesFound = Object.values(priceMap).filter(p => p !== null && p > 0).length;
  const marketCapsFound = Object.values(marketCapMap).filter(m => m !== null && m > 0).length;
  logger.info(`[LiveSignals] Extracted ${pricesFound} prices, ${marketCapsFound} market caps`);
  
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

  // STEP 4: Calculate PnL for EVERY signal (EXACT SAME AS TEST)
  const cachedSignals: CachedSignal[] = signals.map(sig => {
    // Use entry data directly from DB
    const entryPrice = sig.entryPrice ?? null;
    const entryMc = sig.entryMarketCap ?? null;
    
    // Get current price and market cap (EXACT SAME AS TEST)
    const currentPrice = priceMap[sig.mint] ?? null;
    const currentMc = marketCapMap[sig.mint] ?? null;
    
    // CRITICAL DEBUG: Log first few signals
    if (signals.indexOf(sig) < 5) {
      logger.info(`[LiveSignals] Processing ${sig.mint.slice(0, 8)}...: entryPrice=${entryPrice}, entryMc=${entryMc}, currentPrice=${currentPrice}, currentMc=${currentMc}`);
    }
    
    // Calculate PnL (EXACT SAME AS TEST)
    let pnl = -Infinity;
    if (currentPrice !== null && currentPrice > 0 && entryPrice !== null && entryPrice > 0) {
      pnl = ((currentPrice - entryPrice) / entryPrice) * 100;
    } else if (currentMc !== null && currentMc > 0 && entryMc !== null && entryMc > 0) {
      pnl = ((currentMc - entryMc) / entryMc) * 100;
    }
    
    // CRITICAL FIX: Store null if Jupiter returned null, NOT 0
    // We need to distinguish between "Jupiter returned 0" vs "Jupiter returned null"
    // Store the actual value (null or number), then check properly in display
    const storedPrice = currentPrice; // Keep null if null, don't convert to 0
    const storedMc = currentMc; // Keep null if null, don't convert to 0
    
    // Log what we're storing
    if (signals.indexOf(sig) < 5) {
      logger.info(`[LiveSignals] Storing ${sig.mint.slice(0, 8)}...: storedPrice=${storedPrice}, storedMc=${storedMc}, pnl=${isFinite(pnl) ? pnl.toFixed(2) : 'N/A'}`);
    }
    
    return {
      mint: sig.mint,
      symbol: sig.symbol || 'N/A',
      entryPrice: entryPrice ?? 0,
      entryMc: entryMc ?? 0,
      currentPrice: storedPrice ?? 0, // Only convert to 0 for storage (type safety)
      currentMc: storedMc ?? 0, // Only convert to 0 for storage (type safety)
      // Store original null status in a flag for proper checking
      hasPrice: currentPrice !== null && currentPrice > 0,
      hasMc: currentMc !== null && currentMc > 0,
      pnl,
      detectedAt: sig.detectedAt,
      firstDetectedAt: sig.detectedAt,
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

export const handleLiveSignals = async (ctx: BotContext) => {
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

    if (ctx.callbackQuery && ctx.callbackQuery.message) {
      loadingMsg = ctx.callbackQuery.message;
      try {
        await ctx.telegram.editMessageText(
          loadingMsg.chat.id,
          loadingMsg.message_id,
          undefined,
          '⏳ Loading live signals...',
          { parse_mode: 'Markdown' }
        );
      } catch {}
    } else {
      loadingMsg = await ctx.reply('⏳ Loading live signals...');
    }

    // ALWAYS rebuild cache to get fresh prices
    logger.info('[LiveSignals] Building fresh cache with real-time prices');
    const cache = await buildCache(ctx, timeframeCutoff, timeframeLabel);
    ctx.session.liveSignalsCache = cache;

    // Filter by gainers/multipliers
    let filtered = cache.signals.filter((c: CachedSignal) => {
      if (onlyGainers && c.pnl <= 0) return false;
      if (minMult > 0) {
        const requiredPnl = (minMult - 1) * 100;
        if (c.pnl < requiredPnl) return false;
      }
      return true;
    });

    // Sort based on filter type
    if (minMult > 0) {
      filtered.sort((a: CachedSignal, b: CachedSignal) => b.firstDetectedAt.getTime() - a.firstDetectedAt.getTime());
    } else if (sortBy === 'pnl' || sortBy === 'trending') {
      const valid = filtered.filter(c => isFinite(c.pnl));
      const invalid = filtered.filter(c => !isFinite(c.pnl));
      valid.sort((a, b) => b.pnl - a.pnl);
      filtered = [...valid, ...invalid];
    } else if (sortBy === 'newest') {
      filtered.sort((a: CachedSignal, b: CachedSignal) => b.firstDetectedAt.getTime() - a.firstDetectedAt.getTime());
    } else {
      // Default: aggregate by mint, show most recent per mint
      const mintMap = new Map<string, CachedSignal>();
      for (const sig of filtered) {
        const existing = mintMap.get(sig.mint);
        if (!existing || sig.detectedAt.getTime() > existing.detectedAt.getTime()) {
          mintMap.set(sig.mint, sig);
        }
      }
      filtered = Array.from(mintMap.values());
      filtered.sort((a: CachedSignal, b: CachedSignal) => b.detectedAt.getTime() - a.detectedAt.getTime());
    }

    // Get top items
    const topItems = filtered.slice(0, displayLimit);

    // Fetch full signal data for ATH calculation
    const { enrichSignalMetrics } = await import('../../../analytics/metrics');
    const signalMap = new Map<number, any>();
    if (topItems.length > 0) {
      const signals = await prisma.signal.findMany({
        where: { id: { in: topItems.map(i => i.signalId) } },
        include: { metrics: true, priceSamples: { orderBy: { sampledAt: 'asc' }, take: 1 }, group: true, user: true }
      });
      for (const s of signals) signalMap.set(s.id, s);
    }

    // Calculate ATH for top items only
    await Promise.allSettled(topItems.map(async (item: CachedSignal) => {
      const sig = signalMap.get(item.signalId);
      if (sig && item.currentPrice > 0) {
        if (!sig.entryMarketCap && item.entryMc > 0) sig.entryMarketCap = item.entryMc;
        if (!sig.entryPrice && item.entryPrice > 0) sig.entryPrice = item.entryPrice;
        if (!sig.entrySupply && sig.entryMarketCap && sig.entryPrice) {
          sig.entrySupply = sig.entryMarketCap / sig.entryPrice;
        }
        try {
          await Promise.race([
            enrichSignalMetrics(sig, false, item.currentPrice),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000))
          ]);
        } catch {}
      }
    }));

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
    let message = UIHelper.header(`Live Signals (${filtered.length})`);
    if (topItems.length === 0) {
      message += '\nNo signals match your filters.';
    }


    for (const item of topItems) {
      const sig = signalMap.get(item.signalId);
      const meta = metaMap.get(item.mint);

      const displaySymbol = meta?.symbol || item.symbol || 'N/A';
      const callerLabel = sig ? formatCallerLabel(sig) : item.userName || item.groupName || 'Unknown';
      const timeAgo = sig ? UIHelper.formatTimeAgo(sig.detectedAt) : UIHelper.formatTimeAgo(item.detectedAt);

      // CRITICAL DEBUG: Log what we're displaying
      if (topItems.indexOf(item) < 3) {
        logger.info(`[LiveSignals] Displaying ${item.mint.slice(0, 8)}...: currentPrice=${item.currentPrice}, currentMc=${item.currentMc}, pnl=${item.pnl}`);
      }

      // EXACT SAME AS TEST: pnlStr = isFinite(pnl) ? format : 'N/A'
      const pnlStr = isFinite(item.pnl) ? UIHelper.formatPercent(item.pnl) : 'N/A';
      const icon = isFinite(item.pnl) ? (item.pnl >= 0 ? '🟢' : '🔴') : '❓';

      // CRITICAL FIX: Check if we have valid data from Jupiter
      // If hasMc is true, use stored value. If false but hasPrice, calculate from price
      const entryStr = item.entryMc > 0 ? UIHelper.formatMarketCap(item.entryMc) : 'N/A';
      let currentStr = 'N/A';
      
      // First, try to use stored market cap if Jupiter returned it
      if (item.hasMc && item.currentMc > 0) {
        currentStr = UIHelper.formatMarketCap(item.currentMc);
      }
      // If no market cap but we have price, calculate it
      else if (item.hasPrice && item.currentPrice > 0 && sig) {
        // Try to calculate market cap from current price and supply
        if (sig.entrySupply && sig.entrySupply > 0) {
          const calculatedMc = item.currentPrice * sig.entrySupply;
          if (calculatedMc > 0) {
            currentStr = UIHelper.formatMarketCap(calculatedMc);
            logger.info(`[LiveSignals] Calculated MC for ${item.mint.slice(0, 8)}...: ${currentStr} from price=${item.currentPrice}, supply=${sig.entrySupply}`);
          }
        } else if (item.entryPrice > 0 && item.entryMc > 0) {
          // Estimate supply from entry data
          const estimatedSupply = item.entryMc / item.entryPrice;
          if (estimatedSupply > 0) {
            const calculatedMc = item.currentPrice * estimatedSupply;
            if (calculatedMc > 0) {
              currentStr = UIHelper.formatMarketCap(calculatedMc);
              logger.info(`[LiveSignals] Calculated MC for ${item.mint.slice(0, 8)}...: ${currentStr} from price=${item.currentPrice}, estimatedSupply=${estimatedSupply}`);
            }
          }
        }
      }

      // ATH calculation
      const athMult = sig?.metrics?.athMultiple || 0;
      const athMc = sig?.metrics?.athMarketCap || 0;
      const currentMult = isFinite(item.pnl) ? (item.pnl / 100) + 1 : 0;
      const effectiveAth = Math.max(athMult, currentMult);
      const athLabel = effectiveAth > 1.05
        ? `${effectiveAth.toFixed(1)}x ATH${athMc ? ` (${UIHelper.formatMarketCap(athMc)})` : ''}`
        : 'ATH N/A';

      const dexPaid = (meta?.tags || []).some((t: string) => t.toLowerCase().includes('dex')) ? '✅' : '❔';
      const migrated = (meta?.audit?.devMigrations || 0) > 0 ? '✅' : '❔';
      const hasTeam = meta?.audit?.devBalancePercentage !== undefined ? (meta.audit.devBalancePercentage < 5 ? '✅' : '❌') : '❔';
      const hasX = meta?.socialLinks?.twitter ? '✅' : '❔';

      message += `\n${icon} *${displaySymbol}* (\`${item.mint.slice(0,4)}..${item.mint.slice(-4)}\`)\n`;
      message += `💰 Entry: ${entryStr} ➔ Now: ${currentStr} (*${pnlStr}*) | ${athLabel}\n`;
      message += `🍬 Dex: ${dexPaid} | 📦 Mig: ${migrated} | 👥 Team: ${hasTeam} | 𝕏: ${hasX}\n`;
      message += `⏱️ ${timeAgo} ago | 👤 ${callerLabel}\n`;
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
