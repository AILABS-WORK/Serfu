import { Context } from 'telegraf';
import { prisma } from '../../../db';
import { UIHelper } from '../../../utils/ui';
import { logger } from '../../../utils/logger';
import { getLeaderboard, getSignalLeaderboard } from '../../../analytics/aggregator';

type TimeWindow = '1D' | '3D' | '7D' | '30D' | 'ALL' | string;

export const handleGroupLeaderboardCommand = async (ctx: Context, window: TimeWindow = '30D') => {
  try {
    const ownerTelegramId = ctx.from?.id ? BigInt(ctx.from.id) : undefined;
    const statsList = await getLeaderboard('GROUP', window, 'SCORE', 10, ownerTelegramId);

    if (statsList.length === 0) {
      return ctx.reply(`No group data available for ${window}.`);
    }

    const windowLabel = ['1D','3D','7D','30D','ALL'].includes(String(window)) ? String(window) : `Custom ${window}`;
    let message = `🏆 *Top Groups (${windowLabel})*\n_Sorted by Reliability Score_\n\n`;

    const entityButtons: any[] = [];
    statsList.forEach((s: any, i: number) => {
      const rank = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i+1}.`;
      message += `${rank} *${s.name}*\n`;
      message += `   💎 ${s.avgMultiple.toFixed(2)}x Avg | 🎯 ${(s.winRate*100).toFixed(0)}% WR | Score: ${s.score.toFixed(0)}\n\n`;
      if (i < 5) {
        entityButtons.push([{ text: `${rank} ${s.name} Stats`, callback_data: `group_stats_view:${s.id}` }]);
      }
    });

    const keyboard = {
      inline_keyboard: [
        ...entityButtons,
        [
          { text: '1D', callback_data: 'leaderboard_groups:1D' },
          { text: '3D', callback_data: 'leaderboard_groups:3D' },
          { text: '7D', callback_data: 'leaderboard_groups:7D' },
          { text: '30D', callback_data: 'leaderboard_groups:30D' },
          { text: 'ALL', callback_data: 'leaderboard_groups:ALL' },
          { text: 'Custom', callback_data: 'leaderboard_custom:GROUP' }
        ],
        [{ text: '👤 User Leaderboard', callback_data: 'leaderboard_users:30D' }],
        [{ text: '🔙 Analytics', callback_data: 'analytics' }]
      ]
    };

    if (ctx.callbackQuery && ctx.callbackQuery.message) {
      await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: keyboard });
    } else {
      await ctx.reply(message, { parse_mode: 'Markdown', reply_markup: keyboard });
    }
  } catch (error) {
    logger.error('Error in group leaderboard:', error);
    ctx.reply('Error loading leaderboard.');
  }
};

export const handleUserLeaderboardCommand = async (ctx: Context, window: TimeWindow = '30D') => {
  try {
    const ownerTelegramId = ctx.from?.id ? BigInt(ctx.from.id) : undefined;
    const statsList = await getLeaderboard('USER', window, 'SCORE', 10, ownerTelegramId);

    if (statsList.length === 0) {
      return ctx.reply(`No user data available for ${window}.`);
    }

    const windowLabel = ['1D','3D','7D','30D','ALL'].includes(String(window)) ? String(window) : `Custom ${window}`;
    let message = `🏆 *Top Callers (${windowLabel})*\n_Sorted by Reliability Score_\n\n`;
    const entityButtons: any[] = [];

    statsList.forEach((s: any, i: number) => {
      const rank = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i+1}.`;
      message += `${rank} *${s.name}*\n`;
      message += `   💎 ${s.avgMultiple.toFixed(2)}x Avg | 🎯 ${(s.winRate*100).toFixed(0)}% WR | Score: ${s.score.toFixed(0)}\n\n`;
      if (i < 5) {
        entityButtons.push([{ text: `${rank} ${s.name} Stats`, callback_data: `user_stats_view:${s.id}` }]);
      }
    });

    const keyboard = {
      inline_keyboard: [
        ...entityButtons,
        [
          { text: '1D', callback_data: 'leaderboard_users:1D' },
          { text: '3D', callback_data: 'leaderboard_users:3D' },
          { text: '7D', callback_data: 'leaderboard_users:7D' },
          { text: '30D', callback_data: 'leaderboard_users:30D' },
          { text: 'ALL', callback_data: 'leaderboard_users:ALL' },
          { text: 'Custom', callback_data: 'leaderboard_custom:USER' }
        ],
        [{ text: '👥 Group Leaderboard', callback_data: 'leaderboard_groups:30D' }],
        [{ text: '💎 Top Signals', callback_data: 'leaderboard_signals:30D' }],
        [{ text: '🔙 Analytics', callback_data: 'analytics' }]
      ]
    };

    if (ctx.callbackQuery && ctx.callbackQuery.message) {
      await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: keyboard });
    } else {
      await ctx.reply(message, { parse_mode: 'Markdown', reply_markup: keyboard });
    }
  } catch (error) {
    logger.error('Error in user leaderboard:', error);
    ctx.reply('Error loading leaderboard.');
  }
};

export const handleSignalLeaderboardCommand = async (ctx: Context, window: TimeWindow = '30D') => {
  try {
    const ownerTelegramId = ctx.from?.id ? BigInt(ctx.from.id) : undefined;
    const signals = await getSignalLeaderboard(window, 10, ownerTelegramId);

    if (signals.length === 0) {
      return ctx.reply(`No signal data available for ${window}.`);
    }

    const signalIds = signals.map((s: any) => s.id);
    const metricsMap = new Map<number, { maxDrawdown?: number }>();
    if (signalIds.length > 0) {
      const raw = await prisma.signal.findMany({
        where: { id: { in: signalIds } },
        include: { metrics: true }
      });
      for (const s of raw) {
        metricsMap.set(s.id, { maxDrawdown: s.metrics?.maxDrawdown ?? undefined });
      }
    }

    const windowLabel = ['1D','3D','7D','30D','ALL'].includes(String(window)) ? String(window) : `Custom ${window}`;
    let message = `💎 *Top Signals (${windowLabel})*\n_Sorted by ATH Multiple_\n\n`;
    const signalButtons: any[] = [];

    signals.forEach((s: any, i: number) => {
      const rank = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i+1}.`;
      message += `${rank} *${s.symbol}* (${s.athMultiple.toFixed(2)}x)\n`;
      message += `   Caller: ${s.sourceName} | 📅 ${s.detectedAt.toLocaleDateString()}\n`;

      const entryMcStr = s.entryMarketCap ? UIHelper.formatMarketCap(s.entryMarketCap) : 'N/A';
      const athMcStr = s.athMarketCap ? UIHelper.formatMarketCap(s.athMarketCap) : 'N/A';
      const currentMcStr = s.currentMarketCap ? UIHelper.formatMarketCap(s.currentMarketCap) : 'N/A';
      const timeToAthStr = s.timeToAth
        ? s.timeToAth < 60 ? `${Math.round(s.timeToAth)}m` : `${(s.timeToAth / 60).toFixed(1)}h`
        : 'N/A';
      const dd = metricsMap.get(s.id)?.maxDrawdown;
      const ddStr = dd !== undefined ? UIHelper.formatPercent(dd * 100) : 'N/A';

      message += `   Entry MC: ${entryMcStr} | ATH MC: ${athMcStr} | Now MC: ${currentMcStr}\n`;
      message += `   Time to ATH: ${timeToAthStr} | Drawdown: ${ddStr}\n`;
      message += `   \`${s.mint}\`\n\n`;

      if (i < 5) {
        signalButtons.push([{ text: `${rank} ${s.symbol} Stats`, callback_data: `stats:${s.id}` }]);
      }
    });

    const keyboard = {
      inline_keyboard: [
        ...signalButtons,
        [
          { text: '1D', callback_data: 'leaderboard_signals:1D' },
          { text: '3D', callback_data: 'leaderboard_signals:3D' },
          { text: '7D', callback_data: 'leaderboard_signals:7D' },
          { text: '30D', callback_data: 'leaderboard_signals:30D' },
          { text: 'ALL', callback_data: 'leaderboard_signals:ALL' },
          { text: 'Custom', callback_data: 'leaderboard_custom:SIGNAL' }
        ],
        [{ text: '🔙 Leaderboards', callback_data: 'leaderboards_menu' }]
      ]
    };

    if (ctx.callbackQuery && ctx.callbackQuery.message) {
      await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: keyboard });
    } else {
      await ctx.reply(message, { parse_mode: 'Markdown', reply_markup: keyboard });
    }
  } catch (error) {
    logger.error('Error in signal leaderboard:', error);
    ctx.reply('Error loading leaderboard.');
  }
};

