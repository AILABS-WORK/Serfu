import { Telegraf, Context } from 'telegraf';
import { prisma } from '../db';
import { renderChart } from '../charts/renderer';
import { logger } from '../utils/logger';
import {
  handleAnalyticsCommand,
  handleGroupStatsCommand,
  handleUserStatsCommand,
  handleGroupLeaderboardCommand,
  handleUserLeaderboardCommand,
} from './commands/analytics';
import { handleGroupsCommand } from './commands/groups';

export const registerActions = (bot: Telegraf) => {
  bot.action(/^chart:(\d+)$/, async (ctx) => {
    const signalId = parseInt(ctx.match[1]);
    try {
      await ctx.answerCbQuery('Generating chart...');
      
      const signal = await prisma.signal.findUnique({
        where: { id: signalId },
        include: { priceSamples: true }
      });

      if (!signal) {
        return ctx.reply('Signal not found.');
      }

      if (signal.priceSamples.length === 0) {
        return ctx.reply('No price data available yet.');
      }

      const imageBuffer = await renderChart(signal, signal.priceSamples);
      
      await ctx.replyWithPhoto({ source: imageBuffer }, {
        caption: `Chart for ${signal.name || signal.mint}`
      });
      
    } catch (error) {
      logger.error('Error generating chart:', error);
      ctx.reply('Failed to generate chart.');
    }
  });

  bot.action(/^stats:(\d+)$/, async (ctx) => {
    const signalId = parseInt(ctx.match[1]);
    try {
      const signal = await prisma.signal.findUnique({
        where: { id: signalId },
        include: { metrics: true }
      });
      
      if (!signal || !signal.metrics) {
        return ctx.answerCbQuery('No stats available.');
      }

      const m = signal.metrics;
      const text = `
📊 *Stats for ${signal.name}*

Current: $${m.currentPrice.toFixed(6)} (${m.currentMultiple.toFixed(2)}x)
ATH: $${m.athPrice.toFixed(6)} (${m.athMultiple.toFixed(2)}x)
Drawdown: ${(m.maxDrawdown * 100).toFixed(2)}%
Entry: $${signal.entryPrice?.toFixed(6)}
      `;

      await ctx.answerCbQuery();
      await ctx.reply(text, { parse_mode: 'Markdown' });

    } catch (error) {
       logger.error('Error showing stats:', error);
    }
  });

  // Analytics Actions
  bot.action('analytics', handleAnalyticsCommand);
  bot.action('analytics_groups', async (ctx) => {
    await ctx.answerCbQuery();
    const groups = await prisma.group.findMany({
      where: { isActive: true },
      include: {
        groupMetrics: {
          where: { window: '30D' },
          take: 1,
        },
      },
      take: 10,
    });

    if (groups.length === 0) {
      return ctx.reply('No active groups found.');
    }

    let message = '👥 *Groups Overview*\n\n';
    groups.forEach((group: any, index: number) => {
      const metric = group.groupMetrics[0];
      message += `${index + 1}. *${group.name || group.chatId}*\n`;
      if (metric) {
        message += `   Win Rate: ${(metric.hit2Rate * 100).toFixed(1)}% | `;
        message += `Signals: ${metric.totalSignals}\n\n`;
      } else {
        message += `   No metrics yet\n\n`;
      }
    });

    await ctx.reply(message, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '🏆 Leaderboard', callback_data: 'leaderboard_groups:30D' },
          ],
          [
            { text: '🔙 Back', callback_data: 'analytics' },
          ],
        ],
      },
    });
  });

  bot.action('analytics_users', async (ctx) => {
    await ctx.answerCbQuery();
    const users = await prisma.user.findMany({
      include: {
        userMetrics: {
          where: { window: '30D' },
          take: 1,
        },
      },
      take: 10,
    });

    if (users.length === 0) {
      return ctx.reply('No users found.');
    }

    let message = '👤 *Users Overview*\n\n';
    users.forEach((user: any, index: number) => {
      const metric = user.userMetrics[0];
      const userName = user.username || user.firstName || user.userId;
      message += `${index + 1}. *@${userName}*\n`;
      if (metric) {
        message += `   Win Rate: ${(metric.hit2Rate * 100).toFixed(1)}% | `;
        message += `Signals: ${metric.totalSignals}\n\n`;
      } else {
        message += `   No metrics yet\n\n`;
      }
    });

    await ctx.reply(message, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '🏆 Leaderboard', callback_data: 'leaderboard_users:30D' },
          ],
          [
            { text: '🔙 Back', callback_data: 'analytics' },
          ],
        ],
      },
    });
  });

  bot.action('analytics_copytrade', async (ctx) => {
    await ctx.answerCbQuery();
    const { handleCopyTradingCommand } = await import('./commands/copyTrading');
    await handleCopyTradingCommand(ctx, '30D');
  });

  bot.action(/^copytrade:(7D|30D|ALL)$/, async (ctx) => {
    const window = ctx.match[1] as '7D' | '30D' | 'ALL';
    await ctx.answerCbQuery();
    const { handleCopyTradingCommand } = await import('./commands/copyTrading');
    await handleCopyTradingCommand(ctx, window);
  });

  bot.action('analytics_strategies', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply('🎯 Strategy Recommendations\n\nThis feature is being developed...', {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '🔙 Back', callback_data: 'analytics' },
          ],
        ],
      },
    });
  });

  bot.action('analytics_performance', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply('📊 Performance Analysis\n\nThis feature is being developed...', {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '🔙 Back', callback_data: 'analytics' },
          ],
        ],
      },
    });
  });

  bot.action('groups_menu', handleGroupsCommand);

  // Group stats callbacks
  bot.action(/^group_stats:(\d+)$/, async (ctx) => {
    const groupId = parseInt(ctx.match[1]);
    await ctx.answerCbQuery();
    const group = await prisma.group.findUnique({ where: { id: groupId } });
    if (group) {
      await handleGroupStatsCommand(ctx, group.chatId.toString());
    }
  });

  // User stats callbacks
  bot.action(/^user_stats:(\d+)$/, async (ctx) => {
    const userId = parseInt(ctx.match[1]);
    await ctx.answerCbQuery();
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (user) {
      await handleUserStatsCommand(ctx, user.userId.toString());
    }
  });

  // Leaderboard callbacks
  bot.action(/^leaderboard_groups:(7D|30D|ALL)$/, async (ctx) => {
    const window = ctx.match[1] as '7D' | '30D' | 'ALL';
    await ctx.answerCbQuery();
    await handleGroupLeaderboardCommand(ctx, window);
  });

  bot.action(/^leaderboard_users:(7D|30D|ALL)$/, async (ctx) => {
    const window = ctx.match[1] as '7D' | '30D' | 'ALL';
    await ctx.answerCbQuery();
    await handleUserLeaderboardCommand(ctx, window);
  });
};

