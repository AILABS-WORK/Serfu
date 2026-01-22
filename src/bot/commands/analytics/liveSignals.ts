import { subDays } from 'date-fns';
import { prisma } from '../../../db';
import { provider } from '../../../providers';
import { logger } from '../../../utils/logger';
import { UIHelper } from '../../../utils/ui';
import { BotContext } from '../../../types/bot';
import { LiveSignalsCache, CachedSignal } from './types';

// Cache TTL: 5 minutes or until timeframe changes
const CACHE_TTL_MS = 5 * 60 * 1000;

const formatCallerLabel = (sig: any) => {
  const user = sig.user?.username ? `@${sig.user.username}` : null;
  const group = sig.group?.name || (sig.group?.chatId ? `Chat ${sig.group.chatId}` : null);
  if (user && group) return `${user} (${group})`;
  return user || group || 'Unknown';
};

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
      metrics: true,
      priceSamples: { orderBy: { sampledAt: 'asc' }, take: 1 }
    }
  });

  if (signals.length === 0) {
    return { signals: [], fetchedAt: Date.now(), timeframe: timeframeLabel };
  }

  // Get all unique mints for price fetching
  const allMints = [...new Set(signals.map(s => s.mint))];
  const { getMultipleTokenPrices } = await import('../../../providers/jupiter');
  const priceMap = await getMultipleTokenPrices(allMints);

  // Calculate PnL for EVERY signal (keep all signals, don't aggregate)
  const cachedSignals: CachedSignal[] = signals.map(sig => {
    // Use entry data directly from DB (forwarding already set these)
    const entryPrice = sig.entryPrice ?? null;
    const entryMc = sig.entryMarketCap ?? null;
    const entrySupply = sig.entrySupply ?? null;
    
    // Get current price from Jupiter (don't default to 0)
    const currentPrice = priceMap[sig.mint] ?? null;
    
    // Calculate current market cap
    let currentMc: number | null = null;
    if (currentPrice !== null && entrySupply !== null && entrySupply > 0) {
      currentMc = currentPrice * entrySupply;
    } else if (currentPrice !== null && entryPrice !== null && entryMc !== null && entryPrice > 0) {
      // Estimate supply from entry data
      const estimatedSupply = entryMc / entryPrice;
      currentMc = currentPrice * estimatedSupply;
    }
    
    // Calculate PnL - use price if available, otherwise market cap
    // Use -Infinity as sentinel for "cannot calculate"
    let pnl: number = -Infinity;
    if (currentPrice !== null && entryPrice !== null && entryPrice > 0) {
      pnl = ((currentPrice - entryPrice) / entryPrice) * 100;
    } else if (currentMc !== null && entryMc !== null && entryMc > 0) {
      pnl = ((currentMc - entryMc) / entryMc) * 100;
    }
    
    return {
      mint: sig.mint,
      symbol: sig.symbol || 'N/A',
      entryPrice: entryPrice ?? 0,
      entryMc: entryMc ?? 0,
      currentPrice: currentPrice ?? 0,
      currentMc: currentMc ?? 0,
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
    const withTimeout = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
      ]);
    };
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

    const cached = ctx.session.liveSignalsCache;
    const cacheFresh =
      cached &&
      cached.timeframe === timeframeLabel &&
      Date.now() - cached.fetchedAt < CACHE_TTL_MS;

    const cache = cacheFresh
      ? cached
      : await buildCache(ctx, timeframeCutoff, timeframeLabel);

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
      // >2x / >5x: sort by newest creation
      filtered.sort((a: CachedSignal, b: CachedSignal) => b.firstDetectedAt.getTime() - a.firstDetectedAt.getTime());
    } else if (sortBy === 'pnl' || sortBy === 'trending') {
      // Highest PnL: separate valid and invalid, sort valid descending
      const valid = filtered.filter(c => isFinite(c.pnl));
      const invalid = filtered.filter(c => !isFinite(c.pnl));
      valid.sort((a, b) => b.pnl - a.pnl); // Highest first
      filtered = [...valid, ...invalid]; // Valid first, invalid last
    } else if (sortBy === 'newest') {
      // Newest: sort by firstDetectedAt
      filtered.sort((a: CachedSignal, b: CachedSignal) => b.firstDetectedAt.getTime() - a.firstDetectedAt.getTime());
    } else {
      // Default (latest mention): aggregate by mint, show most recent per mint
      const mintMap = new Map<string, CachedSignal>();
      for (const sig of filtered) {
        const existing = mintMap.get(sig.mint);
        if (!existing || sig.detectedAt.getTime() > existing.detectedAt.getTime()) {
          mintMap.set(sig.mint, sig);
        }
      }
      filtered = Array.from(mintMap.values());
      // Sort by detectedAt (most recent activity)
      filtered.sort((a: CachedSignal, b: CachedSignal) => b.detectedAt.getTime() - a.detectedAt.getTime());
    }

    // Get top 10/20
    const topItems = filtered.slice(0, displayLimit);

    // Only for final top 10/20 items, fetch full signal data and calculate ATH
    const { enrichSignalMetrics } = await import('../../../analytics/metrics');
    const signalMap = new Map<number, any>();
    if (topItems.length > 0) {
      const signals = await prisma.signal.findMany({
        where: { id: { in: topItems.map(i => i.signalId) } },
        include: { metrics: true, priceSamples: { orderBy: { sampledAt: 'asc' }, take: 1 }, group: true, user: true }
      });
      for (const s of signals) signalMap.set(s.id, s);
    }

    // Calculate ATH for top items only (don't update cached data)
    await Promise.allSettled(topItems.map(async (item: CachedSignal) => {
      const sig = signalMap.get(item.signalId);
      if (sig) {
        // Use cached entry/current data, don't recalculate
        if (!sig.entryMarketCap && item.entryMc > 0) sig.entryMarketCap = item.entryMc;
        if (!sig.entryPrice && item.entryPrice > 0) sig.entryPrice = item.entryPrice;
        if (!sig.entrySupply && sig.entryMarketCap && sig.entryPrice) {
          sig.entrySupply = sig.entryMarketCap / sig.entryPrice;
        }
        // Calculate ATH using cached currentPrice (don't modify item.currentPrice)
        const currentPrice = item.currentPrice > 0 ? item.currentPrice : undefined;
        try {
          await withTimeout(enrichSignalMetrics(sig, false, currentPrice), 8000);
        } catch {}
      }
    }));

    // Fetch metadata only for display (symbol, audit data), not for PnL calculation
    const metaMap = new Map<string, any>();
    await Promise.allSettled(topItems.map(async (item: CachedSignal) => {
      try {
        const meta = await withTimeout(provider.getTokenMeta(item.mint), 5000);
        metaMap.set(item.mint, meta);
        // Don't update item.currentMc - use cached value for display
      } catch {}
    }));

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

      // Format PnL - handle invalid (-Infinity) case
      const pnlStr = isFinite(item.pnl) ? UIHelper.formatPercent(item.pnl) : 'N/A';
      const icon = isFinite(item.pnl) ? (item.pnl >= 0 ? '🟢' : '🔴') : '❓';

      const entryStr = item.entryMc ? UIHelper.formatMarketCap(item.entryMc) : 'N/A';
      const currentStr = item.currentMc ? UIHelper.formatMarketCap(item.currentMc) : 'N/A';

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

