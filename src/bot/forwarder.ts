import { Signal, Prisma } from '../generated/client';
import { getDestinationGroups } from '../db/groups';
import { prisma } from '../db';
import { getBotInstance } from './instance';
import { logger } from '../utils/logger';
import { scheduleAutoDelete } from '../utils/messageCleanup';
import { checkDuplicateCA, generateFirstSignalCard, generateDuplicateSignalCard } from './signalCard';
import { provider } from '../providers';
import { TokenMeta } from '../providers/types';

export const forwardSignalToDestination = async (signal: Signal) => {
  try {
    // Load signal with relations to get the source group owner
    const signalWithRelations = await prisma.signal.findUnique({
      where: { id: signal.id },
      include: { 
        group: {
          include: {
            owner: true, // Get the owner of the source group
          },
        },
        user: true,
      },
    });

    if (!signalWithRelations || !signalWithRelations.group) {
      return; // No group info, can't forward
    }

    const sourceGroup = signalWithRelations.group;
    if (!sourceGroup?.owner) {
      logger.debug(`Forwarding skipped: No owner for source group ${signal.chatId}`);
      return; // No owner, can't forward
    }
    
    const ownerTelegramId = sourceGroup.owner.userId; // Owner's Telegram ID
    
    // Get destination groups for the owner of the source group
    const destinationGroups = await getDestinationGroups(ownerTelegramId);
    
    if (destinationGroups.length === 0) {
      logger.debug(`Forwarding skipped: No destination groups for owner ${ownerTelegramId}`);
      return; // No destination groups configured for this user
    }

    const bot = getBotInstance();
    const groupName = sourceGroup.name || 'Unknown Group';
    const userName = signalWithRelations.user?.username || signalWithRelations.user?.firstName || 'Unknown User';

    // Fetch fresh meta for the card
    const meta = await provider.getTokenMeta(signal.mint);
    const quote = await provider.getQuote(signal.mint);
    const supply = meta?.supply ?? signal.entrySupply ?? undefined;
    const metaWithLive: TokenMeta = {
      ...meta,
      livePrice: quote.price,
      liveMarketCap: supply ? quote.price * supply : meta.marketCap,
    };

    for (const destGroup of destinationGroups) {
      // Skip if forwarding to same group
      if (destGroup.chatId === signal.chatId) {
        continue;
      }

      // Check if we've already sent THIS signal to this destination
      const existing = await prisma.forwardedSignal.findUnique({
        where: {
          signalId_destGroupId: {
            signalId: signal.id,
            destGroupId: destGroup.chatId,
          },
        },
      });
      if (existing) {
        continue; // Already forwarded this signal instance
      }

      // Check if we've already sent this mint from this source group to this destination
      const alreadySentFromSource = await prisma.forwardedSignal.findFirst({
        where: {
          destGroupId: destGroup.chatId,
          sourceGroupId: signal.chatId,
          signal: {
            mint: signal.mint,
            group: { ownerId },
          },
        },
        include: { signal: true },
      });
      if (alreadySentFromSource) {
        continue; // Avoid spamming destination from the same source group for the same CA
      }

      // Check duplicate across this owner (to label first vs new group mention)
      // Exclude current signal ID to avoid self-match if checking broadly, but checkDuplicateCA handles it
      const duplicateCheck = await checkDuplicateCA(signal.mint, ownerId || undefined, undefined, signal.id);
      const isDup = duplicateCheck.isDuplicate;

      // Generate card
      let message: string;
      let keyboard: any;

      if (isDup && duplicateCheck.firstSignal) {
        message = generateDuplicateSignalCard(
          signal,
          metaWithLive,
          duplicateCheck.firstSignal,
          duplicateCheck.firstGroupName || 'Unknown Group',
          groupName,
          userName
        );
        // Add header for new group mention context
        message = `🆕 *NEW GROUP MENTION*\n\n` + message;
      } else {
        // First time seeing this CA in ANY of owner's groups
        message = await generateFirstSignalCard(signal, metaWithLive, groupName, userName);
      }

      keyboard = {
        inline_keyboard: [
          [
            { text: '📈 Chart', callback_data: `chart:${signal.id}` },
            { text: '📊 Stats', callback_data: `stats:${signal.id}` },
          ],
          [
            { text: '🐋 Analyze Holders', callback_data: `analyze_holders:${signal.id}` },
          ],
          [
            { text: '🔍 View Source', callback_data: `source:${signal.id}` },
            { text: '🔄 Refresh', callback_data: `refresh:${signal.id}` },
          ],
        ],
      };

      const destPrefs = {
        autoDeleteSeconds: destGroup.autoDeleteSeconds ?? null,
        showHideButton: destGroup.showHideButton ?? true
      };

      if (destPrefs.showHideButton) {
        keyboard.inline_keyboard.push([{ text: '🙈 Hide', callback_data: 'hide' }]);
      }

      let sent;
      // Prefer photo if available
      if (metaWithLive.image) {
        try {
          sent = await bot.telegram.sendPhoto(Number(destGroup.chatId), metaWithLive.image, {
            caption: message,
            parse_mode: 'Markdown',
            reply_markup: keyboard,
          });
        } catch (err) {
          logger.warn(`Forwarder: failed to send photo, fallback to text: ${err}`);
          sent = await bot.telegram.sendMessage(Number(destGroup.chatId), message, {
            parse_mode: 'Markdown',
            reply_markup: keyboard,
            link_preview_options: { is_disabled: false },
          });
        }
      } else {
        sent = await bot.telegram.sendMessage(Number(destGroup.chatId), message, {
          parse_mode: 'Markdown',
          reply_markup: keyboard,
          link_preview_options: { is_disabled: false },
        });
      }

      if (sent) {
        scheduleAutoDelete(bot, destGroup.chatId, sent.message_id, destPrefs.autoDeleteSeconds);
      }

      // Record forwarding
      await prisma.forwardedSignal.create({
        data: {
          signalId: signal.id,
          sourceGroupId: signal.chatId,
          destGroupId: destGroup.chatId,
        },
      });

      logger.info(`Signal ${signal.id} forwarded to group ${destGroup.chatId} (owner: ${ownerTelegramId})`);
    }
  } catch (error) {
    logger.error(`Error forwarding signal ${signal.id}:`, error);
  }
};
