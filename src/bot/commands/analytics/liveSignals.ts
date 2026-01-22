import { subDays } from 'date-fns';
import { prisma } from '../../../db';
import { provider } from '../../../providers';
import { logger } from '../../../utils/logger';
import { UIHelper } from '../../../utils/ui';
import { BotContext } from '../../../types/bot';
import { LiveSignalsCache, CachedSignal } from './types';

const CACHE_TTL_MS = 60 * 1000;

const resolveEntrySnapshot = (sig: any) => {
  const firstSample = sig.priceSamples?.[0];
  let entryPrice = sig?.entryPrice || firstSample?.price || 0;
  let entryMarketCap = sig?.entryMarketCap || firstSample?.marketCap || 0;
  let entrySupply = sig?.entrySupply || 0;
  const metrics = sig?.metrics;

  if ((!entryMarketCap || !entryPrice) && metrics?.currentMultiple && metrics.currentMultiple > 0) {
    if (!entryMarketCap && metrics.currentMarketCap) {
      entryMarketCap = metrics.currentMarketCap / metrics.currentMultiple;
    }
    if (!entryPrice && metrics.currentPrice) {
      entryPrice = metrics.currentPrice / metrics.currentMultiple;
    }
  }

  if (!entrySupply && entryPrice > 0 && entryMarketCap > 0) {
    entrySupply = entryMarketCap / entryPrice;
  }

  if (!entryPrice && entrySupply > 0 && entryMarketCap > 0) {
    entryPrice = entryMarketCap / entrySupply;
  }

  if (!entryMarketCap && entryPrice > 0 && entrySupply > 0) {
    entryMarketCap = entryPrice * entrySupply;
  }

  return { entryPrice, entryMarketCap, entrySupply };
};

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

  const mintAggregation = new Map<string, { earliest: any; latest: any }>();
  for (const sig of signals) {
    if (!mintAggregation.has(sig.mint)) {
      mintAggregation.set(sig.mint, { earliest: sig, latest: sig });
      continue;
    }
    const agg = mintAggregation.get(sig.mint)!;
    if (sig.detectedAt < agg.earliest.detectedAt) agg.earliest = sig;
    if (sig.detectedAt > agg.latest.detectedAt) agg.latest = sig;
  }

  const allMints = Array.from(mintAggregation.keys());
  const { getMultipleTokenPrices } = await import('../../../providers/jupiter');
  const priceMap = await getMultipleTokenPrices(allMints);

  const cachedSignals: CachedSignal[] = allMints.map(mint => {
    const agg = mintAggregation.get(mint)!;
    const latestSig = agg.latest;
    const earliestSig = agg.earliest;
    const currentPrice = priceMap[mint] ?? latestSig.metrics?.currentPrice ?? 0;
    const { entryPrice, entryMarketCap, entrySupply } = resolveEntrySnapshot(earliestSig);

    let currentMc = latestSig.metrics?.currentMarketCap || 0;
    let currentMultiple = latestSig.metrics?.currentMultiple || 0;
    if (currentPrice > 0) {
      if (entrySupply > 0) {
        currentMc = currentPrice * entrySupply;
      } else if (entryPrice > 0 && entryMarketCap > 0) {
        const estimatedSupply = entryMarketCap / entryPrice;
        currentMc = currentPrice * estimatedSupply;
      }
    }

    const entryMc = entryMarketCap || 0;
    let pnl = 0;
    if (currentPrice > 0 && entryPrice > 0) {
      pnl = ((currentPrice - entryPrice) / entryPrice) * 100;
    } else if (currentMc > 0 && entryMc > 0) {
      pnl = ((currentMc - entryMc) / entryMc) * 100;
    } else if (currentMultiple > 0) {
      pnl = (currentMultiple - 1) * 100;
      if (!currentMc && entryMc > 0) {
        currentMc = entryMc * currentMultiple;
      }
    }

    return {
      mint,
      symbol: latestSig.symbol || earliestSig.symbol || 'N/A',
      entryPrice: entryPrice || 0,
      entryMc,
      currentPrice,
      currentMc,
      pnl,
      detectedAt: latestSig.detectedAt,
      firstDetectedAt: earliestSig.detectedAt,
      groupId: latestSig.groupId || null,
      groupName: latestSig.group?.name || '',
      userId: latestSig.userId || null,
      userName: latestSig.user?.username
        ? `@${latestSig.user.username}`
        : latestSig.user?.firstName || '',
      signalId: latestSig.id
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

    const cached = ctx.session.liveSignalsCache;
    const cacheFresh =
      cached &&
      cached.timeframe === timeframeLabel &&
      Date.now() - cached.fetchedAt < CACHE_TTL_MS;

    const cache = cacheFresh
      ? cached
      : await buildCache(ctx, timeframeCutoff, timeframeLabel);

    ctx.session.liveSignalsCache = cache;

  let filtered = cache.signals.filter((c: CachedSignal) => {
      if (onlyGainers && c.pnl <= 0) return false;
      if (minMult > 0) {
        const requiredPnl = (minMult - 1) * 100;
        if (c.pnl < requiredPnl) return false;
      }
      return true;
    });

    if (sortBy === 'pnl' || sortBy === 'trending') {
      filtered.sort((a: CachedSignal, b: CachedSignal) => b.pnl - a.pnl);
    } else if (sortBy === 'newest') {
      filtered.sort((a: CachedSignal, b: CachedSignal) => b.firstDetectedAt.getTime() - a.firstDetectedAt.getTime());
    } else {
      filtered.sort((a: CachedSignal, b: CachedSignal) => b.detectedAt.getTime() - a.detectedAt.getTime());
    }

    const topItems = filtered.slice(0, displayLimit);

    const { enrichSignalMetrics } = await import('../../../analytics/metrics');
    const metaMap = new Map<string, any>();
    const signalMap = new Map<number, any>();

    if (topItems.length > 0) {
      const signals = await prisma.signal.findMany({
        where: { id: { in: topItems.map(i => i.signalId) } },
        include: { metrics: true, priceSamples: { orderBy: { sampledAt: 'asc' }, take: 1 }, group: true, user: true }
      });
      for (const s of signals) signalMap.set(s.id, s);
    }

    await Promise.all(topItems.map(async (item: CachedSignal) => {
      try {
        const meta = await provider.getTokenMeta(item.mint);
        metaMap.set(item.mint, meta);
        if (meta.liveMarketCap || meta.marketCap) {
          const currentMc = meta.liveMarketCap || meta.marketCap || 0;
          if (currentMc > 0) {
            item.currentMc = currentMc;
            if (item.entryMc > 0) {
              item.pnl = ((item.currentMc - item.entryMc) / item.entryMc) * 100;
            }
          }
        }
      } catch {}

      const sig = signalMap.get(item.signalId);
      if (sig) {
        if (!sig.entryMarketCap && item.entryMc > 0) sig.entryMarketCap = item.entryMc;
        if (!sig.entryPrice && item.entryPrice > 0) sig.entryPrice = item.entryPrice;
        if (!sig.entrySupply && sig.entryMarketCap && sig.entryPrice) {
          sig.entrySupply = sig.entryMarketCap / sig.entryPrice;
        }
        const currentPrice = item.currentPrice || 0;
        await enrichSignalMetrics(sig, false, currentPrice || undefined);
      }
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

      const pnlStr = UIHelper.formatPercent(item.pnl);
      const icon = item.pnl >= 0 ? '🟢' : '🔴';

      const entryStr = item.entryMc ? UIHelper.formatMarketCap(item.entryMc) : 'N/A';
      const currentStr = item.currentMc ? UIHelper.formatMarketCap(item.currentMc) : 'N/A';

      const athMult = sig?.metrics?.athMultiple || 0;
      const athMc = sig?.metrics?.athMarketCap || 0;
      const currentMult = (item.pnl / 100) + 1;
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

