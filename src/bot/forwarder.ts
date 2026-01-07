import { Signal } from '../generated/client';
import { getDestinationGroups } from '../db/groups';
import { prisma } from '../db';
import { getBotInstance } from './instance';
import { logger } from '../utils/logger';

export const forwardSignalToDestination = async (signal: Signal) => {
  try {
    const destinationGroups = await getDestinationGroups();
    
    if (destinationGroups.length === 0) {
      return; // No destination groups configured
    }

    // Load signal with relations
    const signalWithRelations = await prisma.signal.findUnique({
      where: { id: signal.id },
      include: { group: true, user: true },
    });

    if (!signalWithRelations) {
      return;
    }

    const bot = getBotInstance();
    const groupName = signalWithRelations.group?.name || 'Unknown Group';
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

      // Format forwarded message
      const message = `
🚨 *SIGNAL FROM ${groupName}*

*Token:* ${signal.name} (${signal.symbol})
*Mint:* \`${signal.mint}\`
*Entry:* $${signal.entryPrice?.toFixed(6) || 'Pending'}
*Source Group:* ${groupName}
*From:* @${userName}

[View on Solscan](https://solscan.io/token/${signal.mint})
      `;

      // Forward to destination group
      await bot.telegram.sendMessage(Number(destGroup.chatId), message, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '📊 Chart', callback_data: `chart:${signal.id}` },
              { text: '📈 Stats', callback_data: `stats:${signal.id}` },
            ],
            [
              { text: '🔍 View Source', callback_data: `source:${signal.id}` },
            ],
          ],
        },
      });

      // Record forwarding
      await prisma.forwardedSignal.create({
        data: {
          signalId: signal.id,
          sourceGroupId: signal.chatId,
          destGroupId: destGroup.chatId,
        },
      });

      logger.info(`Signal ${signal.id} forwarded to group ${destGroup.chatId}`);
    }
  } catch (error) {
    logger.error(`Error forwarding signal ${signal.id}:`, error);
  }
};

