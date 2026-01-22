import { RawMessage, Prisma } from '../generated/client';
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
  let dexPaid = false;
  let migrated = false;
  
  try {
    const events = detectEvents(rawText);
    
    if (events.length > 0) {
      if (events.includes('dex_payment')) dexPaid = true;
      if (events.includes('migrating')) migrated = true;
      
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
    const tokenCreatedAt = meta.createdAt || meta.firstPoolCreatedAt || null;

    try {
      const quote = await provider.getQuote(mint); // Prefer Jupiter (inside provider)
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

    if (!groupId) {
      logger.debug(`Skipping signal ${mint} because group is not claimed/linked for chat ${message.chatId}`);
      return;
    }
    if (rawMsg?.group?.ownerId) {
      ownerForDuplicate = rawMsg.group.ownerId;
    }

    // SEARCH FOR EXISTING SIGNAL IN SCOPE TO REUSE ENTRY DATA
    // This ensures that if the token was called previously in the workspace, 
    // we attribute the PnL to the original entry price, not the current price.
    let reuseEntryData = false;
    try {
        const scopeWhere: any = { mint };
        if (ownerForDuplicate) {
            scopeWhere.group = { ownerId: ownerForDuplicate };
        } else if (groupId) {
            scopeWhere.groupId = groupId;
        }

        const earliestSignal = await prisma.signal.findFirst({
            where: scopeWhere,
            orderBy: { detectedAt: 'asc' }
        });

        if (earliestSignal && earliestSignal.entryPrice && earliestSignal.entryMarketCap) {
            logger.info(`Reusing entry data for ${mint} from signal ${earliestSignal.id} (Entry: $${earliestSignal.entryMarketCap})`);
            entryPrice = earliestSignal.entryPrice;
            entryMarketCap = earliestSignal.entryMarketCap;
            entrySupply = earliestSignal.entrySupply;
            tokenCreatedAt = earliestSignal.tokenCreatedAt || tokenCreatedAt;
            entryProvider = earliestSignal.entryPriceProvider || entryProvider;
            dexPaid = earliestSignal.dexPaid || dexPaid;
            // Capture the original entry time to detect this is a follow-up
            if (earliestSignal.entryPriceAt) {
                 // Store original entry time in a way we can detect? 
                 // We'll pass it to createSignal via entryPriceAt
            }
            reuseEntryData = true;
        }
    } catch (err) {
        logger.warn(`Failed to lookup earliest signal for ${mint}:`, err);
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
      entryPriceAt: reuseEntryData && earliestSignal?.entryPriceAt ? earliestSignal.entryPriceAt : (entryPrice ? new Date() : null),
      entryPriceProvider: entryProvider,
      entryMarketCap,
      entrySupply,
      tokenCreatedAt,
      trackingStatus,
      detectedAt: new Date(),
      dexPaid,
      migrated: migrated || ((meta.audit?.devMigrations || 0) > 0),
      socials: meta.socialLinks || undefined,
      ...(groupId ? { group: { connect: { id: groupId } } } : {}),
      ...(userId ? { user: { connect: { id: userId } } } : {}),
    });

    logger.info(`Signal created: ${signal.id} for ${mint} at ${entryPrice} from group ${chatId}`);

    // Check if this is a duplicate CA (workspace-scoped, exclude this signal)
    let duplicateCheck = await checkDuplicateCA(mint, ownerForDuplicate, groupId || undefined, signal.id);
    if (rawMsg?.group?.type === 'destination' && ownerForDuplicate) {
      const firstSignal = await prisma.signal.findFirst({
        where: {
          mint,
          group: {
            ownerId: ownerForDuplicate,
            type: 'source',
          },
        },
        orderBy: { detectedAt: 'asc' },
        include: { group: true },
      });
      if (firstSignal && firstSignal.id !== signal.id) {
        duplicateCheck = {
          isDuplicate: true,
          firstSignal,
          firstGroupName: firstSignal.group?.name || 'Unknown Group',
        };
      }
    }

    // Fetch a fresh quote for current stats (for notification only)
    let livePrice: number | null = null;
    let liveMarketCap: number | null = null;
    try {
      const freshQuote = await provider.getQuote(mint); // Fresh price for notification
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

