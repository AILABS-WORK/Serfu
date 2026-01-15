import { Telegraf, Context, session } from 'telegraf';
import { BotContext } from '../types/bot';

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
import { handleSettingsCommand } from './commands/settings';
import { getJupiterPrice, getJupiterTokenInfo } from '../providers/jupiter';

export const setupBot = () => {
  const token = process.env.BOT_TOKEN;
  if (!token) {
    throw new Error('BOT_TOKEN must be provided!');
  }

  const bot = new Telegraf<BotContext>(token);
  setBotInstance(bot);

  // Session Middleware (In-memory for now)
  bot.use(session());

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
          [{ text: '🏆 Leaderboards', callback_data: 'leaderboards_menu' }], // Changed data to match actions.ts
          [{ text: '📊 Distributions', callback_data: 'distributions' }],
          [{ text: '📈 Analytics', callback_data: 'analytics' }],
          [{ text: '🧠 Strategy', callback_data: 'strategy_menu' }],
          [{ text: '👥 Groups', callback_data: 'groups_menu' }],
          [{ text: '⚙️ Settings', callback_data: 'settings_menu' }],
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
      `3. Add bot to source groups/channels to monitor\n` +
      `4. Bot tracks signals and routes alerts automatically\n\n` +
      `*Main Commands:*\n` +
      `/menu - Open main menu\n` +
      `/groups - Manage monitored groups/channels\n` +
      `/analytics - View analytics dashboard\n` +
      `/groupstats - View group performance\n` +
      `/userstats <id> - View user performance\n` +
      `/groupleaderboard - Group rankings\n` +
      `/userleaderboard - User rankings\n` +
      `/strategy - Strategy builder menu\n` +
      `/copytrade - Strategy recommendations\n` +
      `/simulate - Simulate following a strategy\n\n` +
      `*Strategy Builder Capabilities:*\n` +
      `• Target: Overall workspace, a specific group, or a specific user\n` +
      `• Timeframe: 1D/3D/7D/30D/ALL or custom (e.g., 6H, 2W)\n` +
      `• Schedule: Pick days + time windows (UTC)\n` +
      `• Day‑Group Mapping: Assign different groups to different days\n` +
      `• Filters: Min/Max entry MC, Min volume, Min mentions\n` +
      `• Risk Rules: TP/SL multiples, multi‑rule TP/SL with time windows and partial exits\n` +
      `• Rule Priority: TP‑first, SL‑first, or interleaved; stop‑on‑first‑hit optional\n` +
      `• Backtest: Simulate with starting SOL balance + per‑side fees\n` +
      `• Metrics: Win rate, avg multiple, avg ROI, max drawdown, avg hold time\n` +
      `• Presets: Save, enable/disable, edit days, add/remove TP/SL rules\n\n` +
      `*Analytics Capabilities:*\n` +
      `• Distributions: Entry MC buckets, volume buckets, liquidity buckets\n` +
      `• Time‑of‑day: 24h heatmap + day‑specific hourly breakdown\n` +
      `• Recent Calls: Entry MC, current MC, ATH multiple, drawdown, time‑to‑x\n` +
      `• Leaderboards: 1D/3D/7D/30D/ALL + custom windows\n\n` +
      `*Routing & Alerts:*\n` +
      `• Per‑user destination groups and home routing\n` +
      `• Strategy‑based routing (schedule + conditions + day‑group mapping)\n` +
      `• First call vs repost handling with de‑duplication\n\n` +
      `*Group Management:*\n` +
      `/setdestination - Set destination group\n` +
      `/removegroup - Remove a group\n` +
      `/togglegroup - Enable/disable group\n` +
      `/addchannel <id|@username> - Claim a channel\n\n` +
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
  bot.command('settings', handleSettingsCommand);
  bot.command('sethome', async (ctx) => {
    if (!ctx.from?.id || !ctx.chat?.id) {
      return ctx.reply('Unable to set home chat.');
    }
    const { setHomeChat } = await import('./commands/settings');
    await setHomeChat(ctx.from.id, BigInt(ctx.chat.id));
    ctx.reply(`Home chat set to this chat (${ctx.chat.id}).`);
  });
  bot.command('testjup', async (ctx) => {
    try {
      const args = ctx.message.text?.split(' ').slice(1);
      const mint = args?.[0];
      if (!mint) {
        return ctx.reply('Usage: /testjup <mint>');
      }
      // Pure search-based debug to validate Jupiter search/price endpoint
      const info = await getJupiterTokenInfo(mint);
      if (!info) {
        return ctx.reply('Jupiter search returned no data (or unreachable).');
      }
      const lines = [
        `*Jupiter Search Result*`,
        `Mint: \`${mint}\``,
        `Name: ${info.name || 'N/A'}`,
        `Symbol: ${info.symbol || 'N/A'}`,
        `MC: ${info.mcap !== undefined && info.mcap !== null ? `$${info.mcap}` : 'N/A'}`,
        `Liquidity: ${info.liquidity !== undefined && info.liquidity !== null ? `$${info.liquidity}` : 'N/A'}`,
        `Circ Supply: ${info.circSupply ?? 'N/A'}`,
        `Total Supply: ${info.totalSupply ?? 'N/A'}`,
        `1h Change: ${info.stats1h?.priceChange ?? 'N/A'}`,
        `24h Change: ${info.stats24h?.priceChange ?? 'N/A'}`,
        `Icon: ${info.icon || 'N/A'}`,
        `Website: ${info.website || 'N/A'}`,
        `Twitter: ${info.twitter || 'N/A'}`,
        `Telegram: ${info.telegram || 'N/A'}`,
        `Launchpad: ${info.launchpad || 'N/A'}`,
        `CreatedAt: ${info.createdAt || 'N/A'}`,
        `First Pool: ${info.firstPoolId || 'N/A'}`,
      ];
      await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
    } catch (err) {
      logger.error('Error in /testjup:', err);
      ctx.reply('Error testing Jupiter data.');
    }
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

  bot.command('strategy', async (ctx) => {
    const { handleStrategyMenu } = await import('./commands/copyTrading');
    await handleStrategyMenu(ctx);
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

export const launchBot = async (bot: Telegraf<BotContext>) => {
  logger.info('Launching Telegram Bot...');
  
  // Graceful stop
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));

  await bot.launch({
    allowedUpdates: ['message', 'callback_query', 'my_chat_member', 'channel_post']
  });
  logger.info('Bot launched!');
};
