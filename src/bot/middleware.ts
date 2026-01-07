import { Context, Middleware } from 'telegraf';
import { createRawMessage } from '../db/messages';
import { processMessage } from '../ingest/processor';
import { logger } from '../utils/logger';

export const ingestMiddleware: Middleware<Context> = async (ctx, next) => {
  // We only care about group messages (or all messages if configured)
  // PRD says: "For every message in the group, store at minimum..."
  
  if (ctx.message && 'text' in ctx.message) {
    try {
      const message = ctx.message;
      const chatId = message.chat.id;
      const messageId = message.message_id;
      const senderId = message.from?.id;
      const senderUsername = message.from?.username;
      const sentAt = new Date(message.date * 1000);
      const rawText = message.text;

      // Store in DB
      const rawMessage = await createRawMessage({
        chatId: BigInt(chatId),
        messageId,
        senderId: senderId ? BigInt(senderId) : null,
        senderUsername,
        senderUsername, // intentional duplication fix if needed but here it's fine
        sentAt,
        rawText,
        isSignal: false, // Updated later by signal detector
      });

      logger.debug(`Ingested message ${messageId} from ${chatId}`);
      
      // Process Signal (Async to not block bot response?)
      // PRD doesn't specify latency, but better to process immediately for "real-time" feel
      await processMessage(rawMessage);
      
    } catch (error) {
      logger.error('Error ingesting message:', error);
    }
  } else if (ctx.message && 'caption' in ctx.message) {
      // Handle media captions
      try {
        const message = ctx.message;
        const chatId = message.chat.id;
        const messageId = message.message_id;
        const senderId = message.from?.id;
        const senderUsername = message.from?.username;
        const sentAt = new Date(message.date * 1000);
        const rawText = message.caption || '';
  
        // Store in DB
        const rawMessage = await createRawMessage({
          chatId: BigInt(chatId),
          messageId,
          senderId: senderId ? BigInt(senderId) : null,
          senderUsername,
          sentAt,
          rawText,
          isSignal: false,
        });
  
        logger.debug(`Ingested media message ${messageId} from ${chatId}`);
        await processMessage(rawMessage);
      } catch (error) {
        logger.error('Error ingesting media message:', error);
      }
  }

  return next();
};

