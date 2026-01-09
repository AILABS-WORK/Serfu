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
  handleEarliestCallers,
  handleCrossGroupConfirms,
} from './commands/analytics';
import { handleGroupsCommand } from './commands/groups';
import { handleSettingsCommand, setHomeChat, setTtl, toggleHideForChat, toggleHomeFirst, toggleHomeRepost, toggleMcAlerts, togglePriceAlerts } from './commands/settings';

export const registerActions = (bot: Telegraf) => {
  // Hide action: delete the bot message if possible
  bot.action('hide', async (ctx) => {
    try {
      await ctx.answerCbQuery();
      await ctx.deleteMessage();
    } catch (err) {
      logger.debug('Hide action failed:', err);
    }
  });

  bot.action('channel_add', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(
      `📡 *Add Channel (guided)*\n\n` +
      `1) Add this bot as an admin to your channel (read access).\n` +
      `2) *Send me a forwarded message* from that channel here, OR type its @username.\n\n` +
      `I'll auto-claim it for you.`,
      { parse_mode: 'Markdown' }
    );
    if (ctx.from?.id) {
      const { setAwaitChannelClaim } = await import('./state/channelClaimState');
      setAwaitChannelClaim(ctx.from.id);
    }
  });

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
ATH vs Entry: ${(m.athMultiple * 100).toFixed(1)}%
Current vs Entry: ${(m.currentMultiple * 100).toFixed(1)}%
      `;

      await ctx.answerCbQuery();
      await ctx.reply(text, { parse_mode: 'Markdown' });

    } catch (error) {
       logger.error('Error showing stats:', error);
    }
  });

  // Group Management Actions
  bot.action('group_add', async (ctx) => {
    await ctx.answerCbQuery();
    const bot = ctx.telegram;
    const botInfo = await bot.getMe();
    const inviteLink = `https://t.me/${botInfo.username}?startgroup`;
    
    await ctx.reply(
      `➕ *Add Bot to Group*\n\n` +
      `*Method 1: Invite Link*\n` +
      `Click the link below to add the bot to a group:\n` +
      `${inviteLink}\n\n` +
      `*Method 2: Manual*\n` +
      `1. Go to your group\n` +
      `2. Add @${botInfo.username} as member\n` +
      `3. Run /setdestination (for destination)\n` +
      `4. Or bot will auto-track as source\n\n` +
      `*Note:* Each user has their own groups. Other users won't see your groups.`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔗 Copy Invite Link', url: inviteLink }],
            [{ text: '📋 My Groups', callback_data: 'groups_menu' }],
          ],
        },
      }
    );
  });

  bot.action('group_invite', async (ctx) => {
    await ctx.answerCbQuery();
    const bot = ctx.telegram;
    const botInfo = await bot.getMe();
    const inviteLink = `https://t.me/${botInfo.username}?startgroup`;
    
    await ctx.reply(
      `🔗 *Bot Invite Link*\n\n` +
      `${inviteLink}\n\n` +
      `Share this link to easily add the bot to groups!\n` +
      `After adding, run /setdestination in that group.`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔗 Open Link', url: inviteLink }],
            [{ text: '⬅️ Back', callback_data: 'groups_menu' }],
          ],
        },
      }
    );
  });

  bot.action('groups_menu', async (ctx) => {
    await ctx.answerCbQuery();
    await handleGroupsCommand(ctx);
  });

  bot.action('settings_menu', async (ctx) => {
    await ctx.answerCbQuery();
    await handleSettingsCommand(ctx);
  });

  bot.action('toggle_price_alerts', async (ctx) => {
    if (!ctx.from?.id) return;
    await ctx.answerCbQuery();
    const newState = await togglePriceAlerts(ctx.from.id);
    await ctx.reply(`Price alerts are now ${newState ? 'ENABLED' : 'DISABLED'} (2x-100x).`);
  });

  bot.action('toggle_mc_alerts', async (ctx) => {
    if (!ctx.from?.id) return;
    await ctx.answerCbQuery();
    const newState = await toggleMcAlerts(ctx.from.id);
    await ctx.reply(`MC alerts are now ${newState ? 'ENABLED' : 'DISABLED'} (2x-100x).`);
  });

  bot.action('toggle_home_first', async (ctx) => {
    if (!ctx.from?.id) return;
    await ctx.answerCbQuery();
    const newState = await toggleHomeFirst(ctx.from.id);
    await ctx.reply(`Home alerts for first CA are now ${newState ? 'ENABLED' : 'DISABLED'}.`);
  });

  bot.action('toggle_home_repost', async (ctx) => {
    if (!ctx.from?.id) return;
    await ctx.answerCbQuery();
    const newState = await toggleHomeRepost(ctx.from.id);
    await ctx.reply(`Home alerts for reposts are now ${newState ? 'ENABLED' : 'DISABLED'}.`);
  });

  bot.action('set_home_here', async (ctx) => {
    if (!ctx.from?.id || !ctx.chat?.id) return;
    await ctx.answerCbQuery();
    const chatId = BigInt(ctx.chat.id);
    await setHomeChat(ctx.from.id, chatId);
    await ctx.reply(`Home chat set to this chat (${chatId}).`);
  });

  // TTL presets
  bot.action('ttl_off', async (ctx) => { await ctx.answerCbQuery('TTL off'); await setTtl(ctx, null); });
  bot.action('ttl_30', async (ctx) => { await ctx.answerCbQuery('TTL 30s'); await setTtl(ctx, 30); });
  bot.action('ttl_60', async (ctx) => { await ctx.answerCbQuery('TTL 60s'); await setTtl(ctx, 60); });
  bot.action('ttl_180', async (ctx) => { await ctx.answerCbQuery('TTL 180s'); await setTtl(ctx, 180); });
  bot.action('toggle_hide', async (ctx) => { await ctx.answerCbQuery('Toggle hide'); await toggleHideForChat(ctx); });

  // Analytics Actions
  bot.action('analytics', handleAnalyticsCommand);
  bot.action('analytics_groups', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from?.id ? BigInt(ctx.from.id) : null;
    if (!userId) {
      return ctx.reply('❌ Unable to identify user.');
    }
    
    const { getAllGroups } = require('../db/groups');
    const groups = await getAllGroups(userId);
    
    // Filter to active groups and get metrics
    const activeGroups = groups.filter((g: any) => g.isActive);
    
    if (activeGroups.length === 0) {
      return ctx.reply('No active groups found. Add the bot to a group first!');
    }

    const groupsWithMetrics = await Promise.all(
      activeGroups.slice(0, 10).map(async (group: any) => {
        const metrics = await prisma.groupMetric.findFirst({
          where: { groupId: group.id, window: '30D' },
        });
        return { ...group, metric: metrics };
      })
    );

    if (groupsWithMetrics.length === 0) {
      return ctx.reply('No active groups found. Add the bot to a group first!');
    }

    let message = '👥 *Your Groups Overview*\n\n';
    groupsWithMetrics.forEach((group: any, index: number) => {
      const metric = group.metric;
      message += `${index + 1}. *${group.name || `Group ${group.chatId}`}*\n`;
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

  bot.action('analytics_earliest', async (ctx) => {
    await ctx.answerCbQuery();
    await handleEarliestCallers(ctx);
  });

  bot.action('analytics_confirms', async (ctx) => {
    await ctx.answerCbQuery();
    await handleCrossGroupConfirms(ctx);
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

