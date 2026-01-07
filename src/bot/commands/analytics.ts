import { Context } from 'telegraf';
import { prisma } from '../../db';
import { logger } from '../../utils/logger';
import { getAllGroups } from '../../db/groups';
import { getAllUsers } from '../../db/users';

export const handleAnalyticsCommand = async (ctx: Context) => {
  try {
    await ctx.reply('📊 *Analytics Dashboard*', {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '👥 Groups', callback_data: 'analytics_groups' },
            { text: '👤 Users', callback_data: 'analytics_users' },
          ],
          [
            { text: '📈 Copy Trading', callback_data: 'analytics_copytrade' },
            { text: '🎯 Strategies', callback_data: 'analytics_strategies' },
          ],
          [
            { text: '📊 Performance', callback_data: 'analytics_performance' },
          ],
        ],
      },
    });
  } catch (error) {
    logger.error('Error in /analytics command:', error);
    ctx.reply('Error loading analytics.');
  }
};

export const handleGroupStatsCommand = async (ctx: Context, groupIdStr?: string) => {
  try {
    const chatId = ctx.chat?.id;
    const targetChatId = groupIdStr ? BigInt(groupIdStr) : (chatId ? BigInt(chatId) : null);

    if (!targetChatId) {
      return ctx.reply('Please specify a group ID or use this command in a group.');
    }

    const group = await prisma.group.findUnique({
      where: { chatId: targetChatId },
      include: {
        groupMetrics: {
          orderBy: { window: 'asc' },
        },
        signals: {
          take: 10,
          orderBy: { detectedAt: 'desc' },
          include: {
            metrics: true,
          },
        },
      },
    });

    if (!group) {
      return ctx.reply('Group not found.');
    }

    const allTime = group.groupMetrics.find((m: any) => m.window === 'ALL');
    const last30d = group.groupMetrics.find((m: any) => m.window === '30D');
    const last7d = group.groupMetrics.find((m: any) => m.window === '7D');

    let message = `📊 *Group Analytics: ${group.name || group.chatId}*\n\n`;
    
    if (allTime) {
      message += `*All Time Stats:*\n`;
      message += `Signals: ${allTime.totalSignals}\n`;
      message += `Win Rate (2x+): ${(allTime.hit2Rate * 100).toFixed(1)}%\n`;
      message += `Win Rate (5x+): ${(allTime.hit5Rate * 100).toFixed(1)}%\n`;
      message += `Median ATH: ${allTime.medianAth.toFixed(2)}x\n`;
      message += `P75 ATH: ${allTime.p75Ath.toFixed(2)}x\n`;
      message += `Median Drawdown: ${(allTime.medianDrawdown * 100).toFixed(1)}%\n\n`;
    }

    if (last30d) {
      message += `*Last 30 Days:*\n`;
      message += `Signals: ${last30d.totalSignals}\n`;
      message += `Win Rate: ${(last30d.hit2Rate * 100).toFixed(1)}%\n`;
      message += `Median ATH: ${last30d.medianAth.toFixed(2)}x\n\n`;
    }

    if (last7d) {
      message += `*Last 7 Days:*\n`;
      message += `Signals: ${last7d.totalSignals}\n`;
      message += `Win Rate: ${(last7d.hit2Rate * 100).toFixed(1)}%\n`;
    }

    await ctx.reply(message, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '📈 View Signals', callback_data: `group_signals:${group.id}` },
            { text: '📊 Compare', callback_data: `group_compare:${group.id}` },
          ],
          [
            { text: '🔙 Back', callback_data: 'analytics_groups' },
          ],
        ],
      },
    });
  } catch (error) {
    logger.error('Error in /groupstats command:', error);
    ctx.reply('Error fetching group stats.');
  }
};

export const handleUserStatsCommand = async (ctx: Context, userIdStr?: string) => {
  try {
    const senderId = ctx.from?.id;
    const targetUserId = userIdStr ? BigInt(userIdStr) : (senderId ? BigInt(senderId) : null);

    if (!targetUserId) {
      return ctx.reply('Please specify a user ID.');
    }

    const user = await prisma.user.findUnique({
      where: { userId: targetUserId },
      include: {
        userMetrics: {
          orderBy: { window: 'asc' },
        },
        signals: {
          take: 10,
          orderBy: { detectedAt: 'desc' },
          include: {
            metrics: true,
          },
        },
      },
    });

    if (!user) {
      return ctx.reply('User not found.');
    }

    const allTime = user.userMetrics.find((m: any) => m.window === 'ALL');
    const last30d = user.userMetrics.find((m: any) => m.window === '30D');
    const last7d = user.userMetrics.find((m: any) => m.window === '7D');

    let message = `👤 *User Analytics: @${user.username || user.firstName || user.userId}*\n\n`;
    
    if (allTime) {
      message += `*All Time Stats:*\n`;
      message += `Signals: ${allTime.totalSignals}\n`;
      message += `Win Rate (2x+): ${(allTime.hit2Rate * 100).toFixed(1)}%\n`;
      message += `Win Rate (5x+): ${(allTime.hit5Rate * 100).toFixed(1)}%\n`;
      message += `Median ATH: ${allTime.medianAth.toFixed(2)}x\n`;
      message += `P75 ATH: ${allTime.p75Ath.toFixed(2)}x\n`;
      if (allTime.consistencyScore !== null) {
        message += `Consistency: ${(allTime.consistencyScore * 100).toFixed(1)}%\n`;
      }
      if (allTime.riskScore !== null) {
        message += `Risk Score: ${(allTime.riskScore * 100).toFixed(1)}%\n`;
      }
      message += `\n`;
    }

    if (last30d) {
      message += `*Last 30 Days:*\n`;
      message += `Signals: ${last30d.totalSignals}\n`;
      message += `Win Rate: ${(last30d.hit2Rate * 100).toFixed(1)}%\n`;
      message += `Median ATH: ${last30d.medianAth.toFixed(2)}x\n\n`;
    }

    if (last7d) {
      message += `*Last 7 Days:*\n`;
      message += `Signals: ${last7d.totalSignals}\n`;
      message += `Win Rate: ${(last7d.hit2Rate * 100).toFixed(1)}%\n`;
    }

    await ctx.reply(message, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '📈 View Signals', callback_data: `user_signals:${user.id}` },
            { text: '📊 Compare', callback_data: `user_compare:${user.id}` },
          ],
          [
            { text: '🔙 Back', callback_data: 'analytics_users' },
          ],
        ],
      },
    });
  } catch (error) {
    logger.error('Error in /userstats command:', error);
    ctx.reply('Error fetching user stats.');
  }
};

export const handleGroupLeaderboardCommand = async (ctx: Context, window: '7D' | '30D' | 'ALL' = '30D') => {
  try {
    const metrics = await prisma.groupMetric.findMany({
      where: { window },
      include: { group: true },
      orderBy: { hit2Rate: 'desc' },
      take: 20,
    });

    if (metrics.length === 0) {
      return ctx.reply(`No group metrics available for ${window} window.`);
    }

    let message = `🏆 *Group Leaderboard (${window})*\n\n`;
    
    metrics.forEach((metric: any, index: number) => {
      const rank = index + 1;
      const emoji = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `${rank}.`;
      message += `${emoji} *${metric.group.name || metric.group.chatId}*\n`;
      message += `   Win Rate: ${(metric.hit2Rate * 100).toFixed(1)}% | `;
      message += `Signals: ${metric.totalSignals} | `;
      message += `Median ATH: ${metric.medianAth.toFixed(2)}x\n\n`;
    });

    await ctx.reply(message, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '7D', callback_data: `leaderboard_groups:7D` },
            { text: '30D', callback_data: `leaderboard_groups:30D` },
            { text: 'ALL', callback_data: `leaderboard_groups:ALL` },
          ],
          [
            { text: '🔙 Back', callback_data: 'analytics_groups' },
          ],
        ],
      },
    });
  } catch (error) {
    logger.error('Error in group leaderboard:', error);
    ctx.reply('Error loading leaderboard.');
  }
};

export const handleUserLeaderboardCommand = async (ctx: Context, window: '7D' | '30D' | 'ALL' = '30D') => {
  try {
    const metrics = await prisma.userMetric.findMany({
      where: { window },
      include: { user: true },
      orderBy: { hit2Rate: 'desc' },
      take: 20,
    });

    if (metrics.length === 0) {
      return ctx.reply(`No user metrics available for ${window} window.`);
    }

    let message = `🏆 *User Leaderboard (${window})*\n\n`;
    
    metrics.forEach((metric: any, index: number) => {
      const rank = index + 1;
      const emoji = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `${rank}.`;
      const userName = metric.user.username || metric.user.firstName || metric.user.userId;
      message += `${emoji} *@${userName}*\n`;
      message += `   Win Rate: ${(metric.hit2Rate * 100).toFixed(1)}% | `;
      message += `Signals: ${metric.totalSignals} | `;
      message += `Median ATH: ${metric.medianAth.toFixed(2)}x\n`;
      if (metric.consistencyScore !== null) {
        message += `   Consistency: ${(metric.consistencyScore * 100).toFixed(1)}%\n`;
      }
      message += `\n`;
    });

    await ctx.reply(message, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '7D', callback_data: `leaderboard_users:7D` },
            { text: '30D', callback_data: `leaderboard_users:30D` },
            { text: 'ALL', callback_data: `leaderboard_users:ALL` },
          ],
          [
            { text: '🔙 Back', callback_data: 'analytics_users' },
          ],
        ],
      },
    });
  } catch (error) {
    logger.error('Error in user leaderboard:', error);
    ctx.reply('Error loading leaderboard.');
  }
};

