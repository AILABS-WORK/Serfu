import { Telegraf } from 'telegraf';
import { logger } from '../utils/logger';
import { ingestMiddleware } from './middleware';
import { setBotInstance } from './instance';
import { registerActions } from './actions';
import {
  handleGroupsCommand,
  handleSetDestinationCommand,
  handleRemoveGroupCommand,
  handleToggleGroupCommand,
  handleAddChannelCommand,
} from './commands/groups';
import {
  handleAnalyticsCommand,
  handleGroupStatsCommand,
  handleUserStatsCommand,
  handleGroupLeaderboardCommand,
  handleUserLeaderboardCommand,
} from './commands/analytics';

export const setupBot = () => {
  const token = process.env.BOT_TOKEN;
  if (!token) {
    throw new Error('BOT_TOKEN must be provided!');
  }

  const bot = new Telegraf(token);
  setBotInstance(bot);

  // Middleware
  bot.use(ingestMiddleware);
  
  // Actions
  registerActions(bot);

  // Commands
  bot.command('menu', (ctx) => {
    ctx.reply('AlphaColor Bot Menu', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🟢 Live Signals', callback_data: 'live_signals' }],
          [{ text: '🏆 Leaderboards', callback_data: 'leaderboard' }],
          [{ text: '📊 Distributions', callback_data: 'distributions' }],
          [{ text: '📈 Analytics', callback_data: 'analytics' }],
          [{ text: '👥 Groups', callback_data: 'groups_menu' }],
          [{ text: '⭐ Watchlist', callback_data: 'watchlist' }],
        ],
      },
    });
  });

  bot.command('ping', (ctx) => ctx.reply('Pong!'));
  
  bot.command('help', (ctx) => {
    ctx.reply(
      `📚 *AlphaColor Bot Help*\n\n` +
      `*Quick Setup:*\n` +
      `1. Add bot to your destination group\n` +
      `2. Run /setdestination in that group\n` +
      `3. Add bot to source groups to monitor\n` +
      `4. Bot will auto-track and forward signals\n\n` +
      `*Main Commands:*\n` +
      `/menu - Open main menu\n` +
      `/groups - Manage monitored groups\n` +
      `/analytics - View analytics dashboard\n` +
      `/groupstats - View group performance\n` +
      `/userstats <id> - View user performance\n` +
      `/groupleaderboard - Group rankings\n` +
      `/userleaderboard - User rankings\n` +
      `/copytrade - Strategy recommendations\n` +
      `/simulate - Simulate following a strategy\n\n` +
      `*Group Management:*\n` +
      `/setdestination - Set destination group\n` +
      `/removegroup - Remove a group\n` +
      `/togglegroup - Enable/disable group\n\n` +
      `*Need More Help?*\n` +
      `See README.md for complete documentation\n` +
      `Or check /groups to verify your setup`,
      { parse_mode: 'Markdown' }
    );
  });

  // Group Management Commands
  bot.command('groups', handleGroupsCommand);
  bot.command('setdestination', (ctx) => {
    const args = ctx.message.text?.split(' ').slice(1);
    handleSetDestinationCommand(ctx, args?.[0]);
  });
  bot.command('removegroup', (ctx) => {
    const args = ctx.message.text?.split(' ').slice(1);
    handleRemoveGroupCommand(ctx, args?.[0]);
  });
  bot.command('togglegroup', (ctx) => {
    const args = ctx.message.text?.split(' ').slice(1);
    handleToggleGroupCommand(ctx, args?.[0]);
  });
  bot.command('addchannel', (ctx) => {
    const args = ctx.message.text?.split(' ').slice(1);
    handleAddChannelCommand(ctx, args?.[0]);
  });

  // Analytics Commands
  bot.command('analytics', handleAnalyticsCommand);
  bot.command('groupstats', (ctx) => {
    const args = ctx.message.text?.split(' ').slice(1);
    handleGroupStatsCommand(ctx, args?.[0]);
  });
  bot.command('userstats', (ctx) => {
    const args = ctx.message.text?.split(' ').slice(1);
    handleUserStatsCommand(ctx, args?.[0]);
  });
  bot.command('groupleaderboard', (ctx) => {
    const args = ctx.message.text?.split(' ').slice(1);
    handleGroupLeaderboardCommand(ctx, (args?.[0] as '7D' | '30D' | 'ALL') || '30D');
  });
  bot.command('userleaderboard', (ctx) => {
    const args = ctx.message.text?.split(' ').slice(1);
    handleUserLeaderboardCommand(ctx, (args?.[0] as '7D' | '30D' | 'ALL') || '30D');
  });

  // Copy Trading Commands
  bot.command('copytrade', async (ctx) => {
    const args = ctx.message.text?.split(' ').slice(1);
    const { handleCopyTradingCommand } = await import('./commands/copyTrading');
    const window = (args?.[0] as '7D' | '30D' | 'ALL') || '30D';
    await handleCopyTradingCommand(ctx, window);
  });

  bot.command('simulate', async (ctx) => {
    const args = ctx.message.text?.split(' ').slice(1);
    if (!args || args.length < 2) {
      return ctx.reply('Usage: /simulate <user|group> <id> [capital]\nExample: /simulate user 123456789 1000');
    }
    const { handleSimulateCommand } = await import('./commands/copyTrading');
    const strategyType = args[0] as 'user' | 'group';
    const targetId = args[1];
    const capital = args[2] ? parseFloat(args[2]) : 1000;
    await handleSimulateCommand(ctx, strategyType, targetId, capital);
  });

  // Error handling
  bot.catch((err, ctx) => {
    logger.error(`Ooops, encountered an error for ${ctx.updateType}`, err);
  });

  return bot;
};

export const launchBot = async (bot: Telegraf) => {
  logger.info('Launching Telegram Bot...');
  
  // Graceful stop
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));

  await bot.launch();
  logger.info('Bot launched!');
};

