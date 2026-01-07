import { Telegraf } from 'telegraf';
import { logger } from '../utils/logger';
import { ingestMiddleware } from './middleware';
import { setBotInstance } from './instance';
import { registerActions } from './actions';

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
          [{ text: '⭐ Watchlist', callback_data: 'watchlist' }],
        ],
      },
    });
  });

  bot.command('ping', (ctx) => ctx.reply('Pong!'));

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

