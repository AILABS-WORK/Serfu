import { Context } from 'telegraf';
import { subDays } from 'date-fns';
import { prisma } from '../../../db';
import { provider } from '../../../providers';
import { logger } from '../../../utils/logger';
import { UIHelper } from '../../../utils/ui';
import { updateHistoricalMetrics } from '../../../jobs/historicalMetrics';

const resolveSince = (window: string): Date | null => {
  const normalized = window.toUpperCase();
  if (normalized === 'ALL') return null;
  if (normalized === '1D') return subDays(new Date(), 1);
  if (normalized === '3D') return subDays(new Date(), 3);
  if (normalized === '7D') return subDays(new Date(), 7);
  if (normalized === '30D') return subDays(new Date(), 30);
  const parsed = UIHelper.parseTimeframeInput(normalized);
  if (parsed) return new Date(Date.now() - parsed.ms);
  return subDays(new Date(), 7);
};

export const handleRecentCalls = async (ctx: Context, window: string = '7D') => {
  try {
    const ownerTelegramId = ctx.from?.id ? BigInt(ctx.from.id) : null;
    if (!ownerTelegramId) return ctx.reply('❌ Unable to identify user.');

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
      return ctx.reply('You are not monitoring any groups/channels yet.');
    }

    if (!(ctx as any).session) (ctx as any).session = {};
    if (!(ctx as any).session.recent) (ctx as any).session.recent = {};
    const storedWindow = (ctx as any).session.recent.timeframe;
    const effectiveWindow = window || storedWindow || '7D';
    (ctx as any).session.recent.timeframe = effectiveWindow;
    if (!(ctx as any).session.recent.chain) (ctx as any).session.recent.chain = 'both';
    const chain = (ctx as any).session.recent.chain || 'both';

    let loadingMsg: any = null;
    if (ctx.callbackQuery && ctx.callbackQuery.message) {
      loadingMsg = ctx.callbackQuery.message;
      try {
        await ctx.telegram.editMessageText(
          loadingMsg.chat.id,
          loadingMsg.message_id,
          undefined,
          '⏳ Loading recent calls...'
        );
      } catch {}
    } else {
      loadingMsg = await ctx.reply('⏳ Loading recent calls...');
    }

    const since = resolveSince(effectiveWindow);
    const timeFilter = since
      ? {
          OR: [
            { entryPriceAt: { gte: since } },
            { entryPriceAt: null, detectedAt: { gte: since } }
          ]
        }
      : {};
    const rawSignals = await prisma.signal.findMany({
      where: {
        OR: [
          { chatId: { in: ownedChatIds } },
          { id: { in: forwardedSignalIds } }
        ],
        ...(chain !== 'both' ? { chain } : {}),
        ...timeFilter
      },
      orderBy: { detectedAt: 'desc' },
      take: 40,
      include: {
        group: true,
        user: true,
        metrics: true,
        priceSamples: { orderBy: { sampledAt: 'asc' }, take: 1 }
      }
    });

    if (rawSignals.length === 0) {
      return ctx.reply('No signals yet in your workspace.', {
        reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'analytics' }]] }
      });
    }

    const seenMap = new Set<string>();
    const uniqueSignals = [];
    for (const sig of rawSignals) {
      const key = `${sig.groupId || 'unknown'}:${sig.mint}`;
      if (seenMap.has(key)) continue;
      seenMap.add(key);
      uniqueSignals.push(sig);
      if (uniqueSignals.length >= 10) break;
    }

    const signals = uniqueSignals;
    const { enrichSignalsBatch, enrichSignalsWithCurrentPrice } = await import('../../../analytics/metrics');
    await enrichSignalsBatch(signals as any);
    await enrichSignalsWithCurrentPrice(signals as any);
    updateHistoricalMetrics(uniqueSignals.map((s: any) => s.id)).catch((err: any) => {
      logger.debug('Background metric update failed:', err);
    });

    const windowLabel = ['1D','3D','7D','30D','ALL'].includes(String(effectiveWindow)) ? String(effectiveWindow) : `Custom ${effectiveWindow}`;
    let message = UIHelper.header(`RECENT ACTIVITY LOG (${windowLabel})`, '📜');

    const metaMap = new Map<string, any>();
    await Promise.all(signals.map(async (s: any) => {
      try {
        const meta = await provider.getTokenMeta(s.mint);
        metaMap.set(s.mint, meta);
      } catch {}
    }));

    for (const sig of signals) {
      const currentPrice = sig.metrics?.currentPrice || 0;
      const entryMc = sig.entryMarketCap || sig.priceSamples?.[0]?.marketCap || 0;
      const meta = metaMap.get(sig.mint);
      const currentMc = sig.metrics?.currentMarketCap || (meta?.marketCap || 0);

      const entryStr = entryMc ? UIHelper.formatMarketCap(entryMc) : 'N/A';
      const currStr = currentMc ? UIHelper.formatMarketCap(currentMc) : 'N/A';

      const pnl = sig.metrics?.currentMultiple ? (sig.metrics.currentMultiple - 1) * 100 : 0;
      const pnlStr = UIHelper.formatPercent(pnl);
      const icon = UIHelper.getStatusIcon(pnl);

      const ath = sig.metrics?.athMultiple || 0;
      const drawdown = sig.metrics?.maxDrawdown ?? null;
      const athMc = sig.metrics?.athMarketCap || 0;
      const timeTo2x = UIHelper.formatDurationMinutes(sig.metrics?.timeTo2x ? sig.metrics.timeTo2x / (1000 * 60) : null);
      const timeTo5x = UIHelper.formatDurationMinutes(sig.metrics?.timeTo5x ? sig.metrics.timeTo5x / (1000 * 60) : null);
      const timeTo10x = UIHelper.formatDurationMinutes(sig.metrics?.timeTo10x ? sig.metrics.timeTo10x / (1000 * 60) : null);

      const time = sig.detectedAt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
      const source = sig.user?.username
        ? `👤 @${sig.user.username}`
        : `📢 ${sig.group?.name || 'Unknown Channel'}`;

      message += `🕒 *${time}* | ${icon} *${sig.symbol || 'UNKNOWN'}*\n`;
      message += `   via ${source}\n`;
      message += `   💰 Entry MC: ${entryStr} ➔ Now MC: ${currStr} (${pnlStr})\n`;
      const drawdownStr = drawdown !== null ? UIHelper.formatPercent(drawdown) : 'N/A';
      message += `   🏔️ ATH: ${ath > 0 ? `${ath.toFixed(2)}x` : 'N/A'} | ATH MC: ${athMc ? UIHelper.formatMarketCap(athMc) : 'N/A'} | 📉 Drawdown: ${drawdownStr}\n`;
      message += `   ⏱️ Time to 2x/5x/10x: ${timeTo2x} / ${timeTo5x} / ${timeTo10x}\n`;
      message += UIHelper.separator('LIGHT');
    }

    await ctx.telegram.editMessageText(loadingMsg.chat.id, loadingMsg.message_id, undefined, message, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: chain === 'both' ? '✅ Both' : 'Both', callback_data: 'recent_chain:both' },
            { text: chain === 'solana' ? '✅ SOL' : 'SOL', callback_data: 'recent_chain:solana' },
            { text: chain === 'bsc' ? '✅ BSC' : 'BSC', callback_data: 'recent_chain:bsc' }
          ],
          [
            { text: '1D', callback_data: 'recent_window:1D' },
            { text: '3D', callback_data: 'recent_window:3D' },
            { text: '7D', callback_data: 'recent_window:7D' },
            { text: '30D', callback_data: 'recent_window:30D' },
            { text: 'ALL', callback_data: 'recent_window:ALL' },
            { text: 'Custom', callback_data: 'recent_window:custom' }
          ],
          [{ text: '🔄 Refresh', callback_data: 'analytics_recent' }],
          [{ text: '🔙 Back', callback_data: 'analytics' }, { text: '❌ Close', callback_data: 'delete_msg' }]
        ]
      }
    });
  } catch (error) {
    logger.error('Error loading recent calls:', error);
    try { await ctx.reply('Error loading recent calls.'); } catch {}
  }
};

