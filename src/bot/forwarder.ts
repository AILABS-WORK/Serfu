import { Signal } from '../generated/client/client';
import { getDestinationGroups } from '../db/groups';
import { prisma } from '../db';
import { getBotInstance } from './instance';
import { logger } from '../utils/logger';
import { scheduleAutoDelete } from '../utils/messageCleanup';
import { checkDuplicateCA } from './signalCard';

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
      return; // No owner, can't forward
    }
    
    const ownerTelegramId = sourceGroup.owner.userId; // Owner's Telegram ID
    const ownerId = sourceGroup.ownerId;
    
    // Get destination groups for the owner of the source group
    const destinationGroups = await getDestinationGroups(ownerTelegramId);
    
    if (destinationGroups.length === 0) {
      return; // No destination groups configured for this user
    }

    const bot = getBotInstance();
    const groupName = sourceGroup.name || 'Unknown Group';
    const originType = sourceGroup.chatType === 'channel' ? 'Channel' : 'Group';
    const userName = signalWithRelations.user?.username || signalWithRelations.user?.firstName || 'Unknown User';

    for (const destGroup of destinationGroups) {
      // Skip if forwarding to same group
      if (destGroup.chatId === signal.chatId) {
        continue;
      }

      // Check if already forwarded
      const existing = await prisma.forwardedSignal.findUnique({
        where: {
          signalId_destGroupId: {
            signalId: signal.id,
            destGroupId: destGroup.chatId,
          },
        },
      });

      if (existing) {
        continue; // Already forwarded
      }

      // Check duplicate across this owner
      const duplicateCheck = await checkDuplicateCA(signal.mint, destGroup.chatId, ownerId || undefined);
      const isDup = duplicateCheck.isDuplicate;

      // Format forwarded message
      const header = isDup ? '🔄 CA POSTED AGAIN' : `🚨 SIGNAL FROM ${originType}`;
      const originLine = `*Source ${originType}:* ${groupName}`;
      const userLine = `*From:* @${userName}`;
      const entryLine = `*Entry:* $${signal.entryPrice?.toFixed(6) || 'Pending'}`;
      const mintLine = `*Mint:* \`${signal.mint}\``;
      const tokenLine = `*Token:* ${signal.name} (${signal.symbol})`;
      const duplicateExtra = isDup
        ? `\n*First mention:* ${duplicateCheck.firstGroupName || 'Unknown'}`
        : '';

      const message = `
${header}

${tokenLine}
${mintLine}
${entryLine}
${originLine}
${userLine}${duplicateExtra}

[View on Solscan](https://solscan.io/token/${signal.mint})
      `;

      // Forward to destination group
      const sent = await bot.telegram.sendMessage(Number(destGroup.chatId), message, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '📊 Chart', callback_data: `chart:${signal.id}` },
              { text: '📈 Stats', callback_data: `stats:${signal.id}` },
            ],
            [
              { text: '🔍 View Source', callback_data: `source:${signal.id}` },
              { text: '🙈 Hide', callback_data: 'hide' },
            ],
          ],
        },
      });
      scheduleAutoDelete(bot, destGroup.chatId, sent.message_id);

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

