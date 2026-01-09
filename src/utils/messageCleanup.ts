import { Telegraf } from 'telegraf';
import { logger } from './logger';

const DEFAULT_AUTO_DELETE_SECONDS = Number(process.env.AUTO_DELETE_SECONDS || '60');

/**
 * Schedule deletion of a bot-sent message after the configured TTL.
 * Does not delete user messages. Requires bot delete rights in the chat.
 */
export const scheduleAutoDelete = (
  bot: Telegraf,
  chatId: bigint | number,
  messageId: number,
  seconds?: number | null,
) => {
  const ttl = seconds ?? DEFAULT_AUTO_DELETE_SECONDS;
  if (!ttl || ttl <= 0) return;
  const delayMs = ttl * 1000;

  setTimeout(async () => {
    try {
      await bot.telegram.deleteMessage(Number(chatId), messageId);
    } catch (err: any) {
      // Log and move on; missing permissions are expected in some chats.
      logger.debug(`Auto-delete failed for message ${messageId} in chat ${chatId}: ${err?.message || err}`);
    }
  }, delayMs);
};

/**
 * Expose default for use in keyboards/settings if needed.
 */
export const getDefaultAutoDeleteSeconds = () => DEFAULT_AUTO_DELETE_SECONDS;



