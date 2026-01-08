import { Signal } from '../generated/client/client';
import { getBotInstance } from './instance';
import { logger } from '../utils/logger';
import { prisma } from '../db';
import { TokenMeta } from '../providers/types';
import { generateFirstSignalCard, generateDuplicateSignalCard } from './signalCard';
import { scheduleAutoDelete } from '../utils/messageCleanup';

interface DuplicateCheck {
  isDuplicate: boolean;
  firstSignal?: Signal;
  firstGroupName?: string;
}

export const notifySignal = async (
  signal: Signal, 
  meta?: TokenMeta,
  duplicateCheck?: DuplicateCheck
) => {
  try {
    const bot = getBotInstance();
    const chatId = signal.chatId;

    // Load group info if available
    const signalWithGroup = await prisma.signal.findUnique({
      where: { id: signal.id },
      include: { group: true, user: true },
    });

    const groupName = signalWithGroup?.group?.name || 'Unknown Group';
    const userName = signalWithGroup?.user?.username || signalWithGroup?.user?.firstName || 'Unknown User';

    let message: string;
    let keyboard: any;

    // Check if this is a duplicate
    if (duplicateCheck?.isDuplicate && duplicateCheck.firstSignal && meta) {
      // Generate duplicate card
      message = generateDuplicateSignalCard(
        signal,
        meta,
        duplicateCheck.firstSignal,
        duplicateCheck.firstGroupName || 'Unknown Group',
        groupName,
        userName
      );
      keyboard = {
        inline_keyboard: [
          [
            { text: '📈 Chart', callback_data: `chart:${signal.id}` },
            { text: '📊 Stats', callback_data: `stats:${signal.id}` },
          ],
          [
            { text: '🔍 View First Call', callback_data: `signal:${duplicateCheck.firstSignal.id}` },
            { text: '⭐ Watchlist', callback_data: `watchlist:${signal.id}` },
            { text: '🙈 Hide', callback_data: 'hide' },
          ],
        ],
      };
    } else if (meta) {
      // Generate rich first signal card
      message = generateFirstSignalCard(signal, meta, groupName, userName);
      keyboard = {
        inline_keyboard: [
          [
            { text: '📈 Chart', callback_data: `chart:${signal.id}` },
            { text: '📊 Stats', callback_data: `stats:${signal.id}` },
          ],
          [
            { text: '⭐ Watchlist', callback_data: `watchlist:${signal.id}` },
            { text: '🔔 Alerts', callback_data: `alerts:${signal.id}` },
            { text: '🙈 Hide', callback_data: 'hide' },
          ],
        ],
      };
    } else {
      // Fallback to basic message
      message = `
🚨 *ALPHA SIGNAL DETECTED* 🚨

*Token:* ${signal.name} (${signal.symbol})
*Mint:* \`${signal.mint}\`
*Entry:* $${signal.entryPrice?.toFixed(6) || 'Pending'}
*Group:* ${groupName}
*From:* @${userName}

[View on Solscan](https://solscan.io/token/${signal.mint})
      `.trim();
      keyboard = {
        inline_keyboard: [
          [
            { text: '📈 Chart', callback_data: `chart:${signal.id}` },
            { text: '📊 Stats', callback_data: `stats:${signal.id}` },
          ],
          [
            { text: '⭐ Watchlist', callback_data: `watchlist:${signal.id}` },
            { text: '🙈 Hide', callback_data: 'hide' },
          ],
        ],
      };
    }

    const sent = await bot.telegram.sendMessage(Number(chatId), message, {
      parse_mode: 'Markdown',
      reply_markup: keyboard,
    });
    // Auto-delete after TTL (configurable via env)
    scheduleAutoDelete(bot, chatId, sent.message_id);
    
    logger.info(`Notification sent for signal ${signal.id}`);
  } catch (error) {
    logger.error(`Failed to send notification for signal ${signal.id}:`, error);
  }
};

