import { RawMessage } from '../generated/client/client';
import { detectSignal } from './classifier';
import { createSignal, getSignalByMint } from '../db/signals';
import { provider } from '../providers';
import { logger } from '../utils/logger';
import { prisma } from '../db';
import { notifySignal } from '../bot/notifier';
import { forwardSignalToDestination } from '../bot/forwarder';
import { checkDuplicateCA } from '../bot/signalCard';
import { detectEvents, sendEventAlerts } from '../bot/eventAlerts';

export const processMessage = async (message: RawMessage) => {
  const { rawText, chatId, messageId } = message;
  
  logger.debug(`Processing message ${messageId} from chat ${chatId}: ${rawText?.substring(0, 50)}...`);
  
  // Event detection (dex payment / bonding / migrating)
  try {
    const events = detectEvents(rawText);
    if (events.length > 0) {
      const rawMsg = await prisma.rawMessage.findUnique({
        where: { id: message.id },
        include: { group: { include: { owner: { include: { notificationSettings: true } } } }, user: true },
      });
      const ownerTelegramId = rawMsg?.group?.owner?.userId;
      const settings = rawMsg?.group?.owner?.notificationSettings;
      if (ownerTelegramId && settings) {
        const allowed = events.filter((e) => {
          if (e === 'dex_payment') return settings.alertDexPayment;
          if (e === 'bonding') return settings.alertBonding;
          if (e === 'migrating') return settings.alertMigrating;
          return false;
        });
        if (allowed.length > 0) {
          const bot = (await import('../bot/instance')).getBotInstance();
          const sourceName = rawMsg?.group?.name || `Chat ${chatId}`;
          const snippet = rawText?.slice(0, 160) || '';
          await sendEventAlerts({
            bot,
            ownerTelegramId,
            sourceChatId: BigInt(chatId),
            sourceName,
            textSnippet: snippet,
            settings,
            events: allowed,
          });
        }
      }
    }
  } catch (err) {
    logger.debug('Event detection error:', err);
  }

  const detection = await detectSignal(rawText);
  
  logger.debug(`Signal detection result: isSignal=${detection.isSignal}, mints=${detection.mints.length}, confidence=${detection.confidence}`);
  
  // Update raw message with detection result
  await prisma.rawMessage.update({
    where: { id: message.id },
    data: {
      isSignal: detection.isSignal,
      parseConfidence: detection.confidence,
      parsedTemplateId: detection.templateId
    }
  });

  if (!detection.isSignal || detection.mints.length === 0) {
    logger.debug(`Message ${messageId} is not a signal or has no mints`);
    return;
  }
  
  logger.info(`Signal detected in message ${messageId}: ${detection.mints[0]}`);

  // Handle first mint found (simplification for v1, usually 1 mint per signal)
  const mint = detection.mints[0];

  try {
    // Check if signal already exists for this message? 
    // DB constraint unique(chatId, messageId) handles duplicates on creation.
    // But we might have processed it already.
    
    // Fetch Metadata
    const meta = await provider.getTokenMeta(mint);
    
    // Fetch Price (Entry) and supply snapshots
    let entryPrice: number | null = null;
    let entryProvider = 'helius';
    let trackingStatus: 'ACTIVE' | 'ENTRY_PENDING' = 'ACTIVE';
    const entrySupply = meta.supply || null;
    let entryMarketCap: number | null = null;

    try {
      const quote = await provider.getQuote(mint);
      entryPrice = quote.price;
      entryProvider = quote.source;
      if (entryPrice && entrySupply) {
        entryMarketCap = entryPrice * entrySupply;
      } else if (meta.marketCap) {
        entryMarketCap = meta.marketCap;
      }
    } catch (err) {
      logger.warn(`Failed to fetch entry price for ${mint}:`, err);
      trackingStatus = 'ENTRY_PENDING';
    }

    // Get group and user IDs from the raw message
    const rawMsg = await prisma.rawMessage.findUnique({
      where: { id: message.id },
      include: { group: { include: { owner: true } }, user: true },
    });

    // Ensure user exists (should already exist from middleware, but double-check)
    let userId = rawMsg?.userId;
    if (!userId && message.senderId) {
      const { createOrUpdateUser } = await import('../db/users');
      const user = await createOrUpdateUser(message.senderId, {});
      userId = user.id;
    }

    // Ensure group/channel exists (should already exist from middleware, but double-check)
    let groupId = rawMsg?.groupId;
    let ownerForDuplicate: number | undefined = rawMsg?.group?.ownerId || undefined;
    if (!groupId && message.chatId) {
      const { createOrUpdateGroup, getAnyGroupByChatId } = await import('../db/groups');
      try {
        // Try to find existing group by chatId (channel/group already claimed)
        const existing = await getAnyGroupByChatId(message.chatId);
        if (existing) {
          groupId = existing.id;
          ownerForDuplicate = existing.ownerId || ownerForDuplicate;
        } else {
          // Use senderId if available, otherwise use chatId as owner (for channels)
          const ownerId = message.senderId || message.chatId;
          const group = await createOrUpdateGroup(message.chatId, ownerId, {
            type: 'source',
            chatType: (message as any).chatType || undefined,
          });
          groupId = group.id;
          ownerForDuplicate = group.ownerId || ownerForDuplicate;
        }
      } catch (error) {
        logger.warn(`Could not create or find group/channel for signal: ${error}`);
      }
    }
    if (rawMsg?.group?.ownerId) {
      ownerForDuplicate = rawMsg.group.ownerId;
    }

    // Create Signal
    const signal = await createSignal({
      chatId,
      messageId,
      senderId: message.senderId,
      mint,
      category: 'General', // TODO: Parse category from text
      name: meta.name,
      symbol: meta.symbol,
      entryPrice,
      entryPriceAt: entryPrice ? new Date() : null,
      entryPriceProvider: entryProvider,
      entryMarketCap,
      entrySupply,
      trackingStatus,
      detectedAt: new Date(),
      ...(groupId ? { group: { connect: { id: groupId } } } : {}),
      ...(userId ? { user: { connect: { id: userId } } } : {}),
    });

    logger.info(`Signal created: ${signal.id} for ${mint} at ${entryPrice} from group ${chatId}`);

    // Check if this is a duplicate CA
    const duplicateCheck = await checkDuplicateCA(mint, ownerForDuplicate);

    // Fetch a fresh quote for current stats (for notification only)
    let livePrice: number | null = null;
    let liveMarketCap: number | null = null;
    try {
      const freshQuote = await provider.getQuote(mint);
      livePrice = freshQuote.price;
      if (meta.supply) {
        liveMarketCap = freshQuote.price * meta.supply;
      }
    } catch (err) {
      logger.debug(`Could not fetch live price for ${mint}:`, err);
    }
    
    // Send Telegram Notification (to source group) with enhanced card
    await notifySignal(signal, { ...meta, livePrice, liveMarketCap }, duplicateCheck);

    // Forward to destination groups (if configured)
    await forwardSignalToDestination(signal);

  } catch (error) {
    if ((error as any).code === 'P2002') {
      logger.debug(`Signal already exists for message ${messageId}`);
    } else {
      logger.error(`Error creating signal for message ${messageId}:`, error);
      logger.error('Error details:', {
        messageId,
        chatId,
        mint: detection.mints[0],
        error: (error as Error).message,
        stack: (error as Error).stack,
      });
    }
  }
};

