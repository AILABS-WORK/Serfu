import { Signal } from '../generated/client';
import { getBotInstance } from './instance';
import { logger } from '../utils/logger';

export const notifySignal = async (signal: Signal) => {
  try {
    const bot = getBotInstance();
    const chatId = signal.chatId;

    const message = `
🚨 *ALPHA SIGNAL DETECTED* 🚨

*Token:* ${signal.name} (${signal.symbol})
*Mint:* \`${signal.mint}\`
*Entry:* $${signal.entryPrice?.toFixed(6) || 'Pending'}
*Category:* ${signal.category || 'Uncategorized'}
*Time:* ${new Date().toUTCString()}

[View on Solscan](https://solscan.io/token/${signal.mint})
`;

    await bot.telegram.sendMessage(Number(chatId), message, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '📈 Chart', callback_data: `chart:${signal.id}` },
            { text: '📊 Stats', callback_data: `stats:${signal.id}` },
          ],
          [
             { text: '⭐ Watchlist', callback_data: `watchlist:${signal.id}` }
          ]
        ],
      },
    });
    
    logger.info(`Notification sent for signal ${signal.id}`);
  } catch (error) {
    logger.error(`Failed to send notification for signal ${signal.id}:`, error);
  }
};

