import { Context, Middleware } from 'telegraf';
import { createRawMessage } from '../db/messages';
import { processMessage } from '../ingest/processor';
import { createOrUpdateGroup } from '../db/groups';
import { createOrUpdateUser } from '../db/users';
import { logger } from '../utils/logger';

export const ingestMiddleware: Middleware<Context> = async (ctx, next) => {
  // We process messages from groups, supergroups, and channels
  // PRD says: "For every message in the group, store at minimum..."
  
  // Handle channel posts separately (channels have different structure in Telegraf)
  const channelPost = (ctx as any).channelPost;
  if (channelPost && typeof channelPost === 'object' && 'text' in channelPost) {
    try {
      const message = channelPost as any;
      const chatId = message.chat?.id;
      const messageId = message.message_id;
      const senderId = message.from?.id || chatId; // Channels might not have senderId
      const senderUsername = message.from?.username;
      const sentAt = new Date(message.date * 1000);
      const rawText = message.text;
      
      if (!chatId || !messageId) {
        return next();
      }
      
      // Create user if sender exists
      let userId: number | null = null;
      if (message.from?.id) {
        const user = await createOrUpdateUser(BigInt(message.from.id), {
          username: senderUsername,
          firstName: message.from?.first_name,
          lastName: message.from?.last_name,
        });
        userId = user.id;
      }
      
      // Create channel record (use chatId as owner if no sender)
      let groupId: number | null = null;
      try {
        const group = await createOrUpdateGroup(BigInt(chatId), BigInt(senderId), {
          name: message.chat?.title || `Channel ${chatId}`,
          type: 'source',
        });
        groupId = group.id;
      } catch (error) {
        logger.debug(`Could not create channel for chat ${chatId}:`, error);
      }
      
      // Store message
      const rawMessage = await createRawMessage({
        chatId: BigInt(chatId),
        messageId,
        senderId: message.from?.id ? BigInt(message.from.id) : null,
        senderUsername,
        sentAt,
        rawText,
        isSignal: false,
        ...(groupId ? { group: { connect: { id: groupId } } } : {}),
        ...(userId ? { user: { connect: { id: userId } } } : {}),
      });
      
      logger.debug(`Ingested channel message ${messageId} from ${chatId}`);
      await processMessage(rawMessage);
    } catch (error) {
      logger.error('Error ingesting channel message:', error);
    }
    return next();
  }
  
  // Skip private chats (DMs) - only process groups/supergroups
  if (ctx.message && 'text' in ctx.message) {
    const chatType = (ctx.message.chat as any).type;
    if (chatType === 'private') {
      return next(); // Skip DMs
    }
    try {
      const message = ctx.message;
      const chatId = message.chat.id;
      const messageId = message.message_id;
      const senderId = message.from?.id;
      const senderUsername = message.from?.username;
      const sentAt = new Date(message.date * 1000);
      const rawText = message.text;

      // Auto-create/update User
      let userId: number | null = null;
      let groupId: number | null = null;

      if (senderId) {
        const user = await createOrUpdateUser(BigInt(senderId), {
          username: senderUsername,
          firstName: message.from?.first_name,
          lastName: message.from?.last_name,
        });
        userId = user.id;
      }

      // For groups: Create group record
      // Groups are user-specific, so we create them when a user interacts
      const isGroup = message.chat.type === 'group' || message.chat.type === 'supergroup';
      
      if (isGroup && senderId) {
        try {
          // Try to find or create group for this user
          const chatTitle = (message.chat as any).title;
          const group = await createOrUpdateGroup(BigInt(chatId), BigInt(senderId), {
            name: chatTitle || undefined,
            type: 'source', // Default to source, can be changed via command
          });
          groupId = group.id;
        } catch (error) {
          // If group creation fails (e.g., user doesn't exist yet), just log and continue
          logger.debug(`Could not create group for chat ${chatId}:`, error);
        }
      }

      // Store in DB
      const rawMessage = await createRawMessage({
        chatId: BigInt(chatId),
        messageId,
        senderId: senderId ? BigInt(senderId) : null,
        senderUsername,
        sentAt,
        rawText,
        isSignal: false, // Updated later by signal detector
        ...(groupId ? { group: { connect: { id: groupId } } } : {}),
        ...(userId ? { user: { connect: { id: userId } } } : {}),
      });

      logger.debug(`Ingested message ${messageId} from ${chatId}`);
      
      // Process Signal (Async to not block bot response?)
      // PRD doesn't specify latency, but better to process immediately for "real-time" feel
      await processMessage(rawMessage);
      
    } catch (error) {
      logger.error('Error ingesting message:', error);
    }
  } else if (channelPost && typeof channelPost === 'object' && 'caption' in channelPost) {
    // Handle channel post captions
    try {
      const message = channelPost as any;
      const chatId = message.chat?.id;
      const messageId = message.message_id;
      const senderId = message.from?.id || chatId;
      const senderUsername = message.from?.username;
      const sentAt = new Date(message.date * 1000);
      const rawText = message.caption || '';
      
      if (!chatId || !messageId) {
        return next();
      }
      
      let userId: number | null = null;
      if (message.from?.id) {
        const user = await createOrUpdateUser(BigInt(message.from.id), {
          username: senderUsername,
          firstName: message.from?.first_name,
          lastName: message.from?.last_name,
        });
        userId = user.id;
      }
      
      let groupId: number | null = null;
      try {
        const group = await createOrUpdateGroup(BigInt(chatId), BigInt(senderId), {
          name: message.chat?.title || `Channel ${chatId}`,
          type: 'source',
        });
        groupId = group.id;
      } catch (error) {
        logger.debug(`Could not create channel for chat ${chatId}:`, error);
      }
      
      const rawMessage = await createRawMessage({
        chatId: BigInt(chatId),
        messageId,
        senderId: message.from?.id ? BigInt(message.from.id) : null,
        senderUsername,
        sentAt,
        rawText,
        isSignal: false,
        ...(groupId ? { group: { connect: { id: groupId } } } : {}),
        ...(userId ? { user: { connect: { id: userId } } } : {}),
      });
      
      logger.debug(`Ingested channel media message ${messageId} from ${chatId}`);
      await processMessage(rawMessage);
    } catch (error) {
      logger.error('Error ingesting channel media message:', error);
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

        // Auto-create/update User
        let userId: number | null = null;
        let groupId: number | null = null;

        if (senderId) {
          const user = await createOrUpdateUser(BigInt(senderId), {
            username: senderUsername,
            firstName: message.from?.first_name,
            lastName: message.from?.last_name,
          });
          userId = user.id;
        }

        // For groups: Create group record
        const isGroup = message.chat.type === 'group' || message.chat.type === 'supergroup';
        
        if (isGroup && senderId) {
          try {
            const chatTitle = (message.chat as any).title;
            const group = await createOrUpdateGroup(BigInt(chatId), BigInt(senderId), {
              name: chatTitle || undefined,
              type: 'source',
            });
            groupId = group.id;
          } catch (error) {
            logger.debug(`Could not create group for chat ${chatId}:`, error);
          }
        }
  
        // Store in DB
        const rawMessage = await createRawMessage({
          chatId: BigInt(chatId),
          messageId,
          senderId: senderId ? BigInt(senderId) : null,
          senderUsername,
          sentAt,
          rawText,
          isSignal: false,
          ...(groupId ? { group: { connect: { id: groupId } } } : {}),
          ...(userId ? { user: { connect: { id: userId } } } : {}),
        });
  
        logger.debug(`Ingested media message ${messageId} from ${chatId}`);
        await processMessage(rawMessage);
      } catch (error) {
        logger.error('Error ingesting media message:', error);
      }
  }

  return next();
};

