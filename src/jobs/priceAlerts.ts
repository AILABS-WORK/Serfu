import { prisma } from '../db';
import { provider } from '../providers';
import { logger } from '../utils/logger';
import { getBotInstance } from '../bot/instance';
import { scheduleAutoDelete } from '../utils/messageCleanup';

// Price multipliers to check
const PRICE_MULTIPLIERS = [2, 3, 4, 5, 10, 15, 20, 30, 50, 100];

// Track which alerts have been sent (to avoid duplicates)
const sentAlerts = new Map<number, Set<number>>(); // signalId -> Set of multipliers

export const checkPriceAlerts = async () => {
  try {
    // Get all active signals with entry prices
    const activeSignals = await prisma.signal.findMany({
      where: {
        trackingStatus: 'ACTIVE',
        entryPrice: { not: null },
      },
      include: {
        user: {
          include: {
            notificationSettings: true,
          },
        },
        group: {
          include: {
            owner: {
              include: {
                notificationSettings: true,
              },
            },
          },
        },
      },
    });

    logger.info(`Checking price alerts for ${activeSignals.length} active signals`);

    for (const signal of activeSignals) {
      if (!signal.entryPrice) continue;

      try {
        // Get current price
        const quote = await provider.getQuote(signal.mint);
        const currentPrice = quote.price;
        const multiplier = currentPrice / signal.entryPrice;

        // Get notification settings (prefer user's, fallback to group owner's)
        const settings = signal.user?.notificationSettings || 
                        signal.group?.owner?.notificationSettings;

        if (!settings) continue; // No settings, skip

        // Check each multiplier threshold
        for (const threshold of PRICE_MULTIPLIERS) {
          if (multiplier >= threshold) {
            // Check if we've already sent this alert
            const alertKey = `${signal.id}_${threshold}x`;
            if (!sentAlerts.has(signal.id)) {
              sentAlerts.set(signal.id, new Set());
            }
            const sentMultipliers = sentAlerts.get(signal.id)!;

            if (sentMultipliers.has(threshold)) {
              continue; // Already sent
            }

            // Check if user wants this alert
            const alertEnabled = getAlertEnabled(settings, threshold);
            if (!alertEnabled) {
              sentMultipliers.add(threshold); // Mark as "sent" so we don't check again
              continue;
            }

            // Send alert
            await sendPriceAlert(signal, threshold, currentPrice, multiplier);
            sentMultipliers.add(threshold);
          }
        }

        // Clean up old alerts (keep last 1000 signals)
        if (sentAlerts.size > 1000) {
          const oldestKeys = Array.from(sentAlerts.keys()).slice(0, 100);
          oldestKeys.forEach(key => sentAlerts.delete(key));
        }
      } catch (error) {
        logger.error(`Error checking price alert for signal ${signal.id}:`, error);
      }
    }
  } catch (error) {
    logger.error('Error in checkPriceAlerts:', error);
  }
};

const getAlertEnabled = (settings: any, multiplier: number): boolean => {
  switch (multiplier) {
    case 2: return settings.alert2x;
    case 3: return settings.alert3x;
    case 4: return settings.alert4x;
    case 5: return settings.alert5x;
    case 10: return settings.alert10x;
    case 15: return settings.alert15x;
    case 20: return settings.alert20x;
    case 30: return settings.alert30x;
    case 50: return settings.alert50x;
    case 100: return settings.alert100x;
    default: return false;
  }
};

const sendPriceAlert = async (
  signal: any,
  threshold: number,
  currentPrice: number,
  multiplier: number
) => {
  try {
    const bot = getBotInstance();
    const settings = signal.user?.notificationSettings || 
                    signal.group?.owner?.notificationSettings;

    if (!settings) return;

    const message = `
🚨 *PRICE ALERT: ${threshold}x REACHED*

*Token:* ${signal.name || 'Unknown'} (${signal.symbol || 'N/A'})
*Mint:* \`${signal.mint}\`
*Entry Price:* $${signal.entryPrice?.toFixed(6)}
*Current Price:* $${currentPrice.toFixed(6)}
*Multiplier:* ${multiplier.toFixed(2)}x

[View on Solscan](https://solscan.io/token/${signal.mint})
    `;

    // Send to destination groups if enabled
    if (settings.notifyDestination && signal.group?.owner?.userId) {
      const { getDestinationGroups } = await import('../db/groups');
      const ownerTelegramId = signal.group.owner.userId;
      const destinations = await getDestinationGroups(ownerTelegramId);
      for (const dest of destinations) {
      const sent = await bot.telegram.sendMessage(Number(dest.chatId), message, {
          parse_mode: 'Markdown',
        });
      scheduleAutoDelete(bot, dest.chatId, sent.message_id);
      }
    }

    // Send DM if enabled
    if (settings.notifyInDM && signal.user?.userId) {
    const sent = await bot.telegram.sendMessage(Number(signal.user.userId), message, {
        parse_mode: 'Markdown',
      });
    scheduleAutoDelete(bot, signal.user.userId, sent.message_id);
    }

    // Send in group if enabled
    if (settings.notifyInGroup && signal.chatId) {
    const sent = await bot.telegram.sendMessage(Number(signal.chatId), message, {
        parse_mode: 'Markdown',
      });
    scheduleAutoDelete(bot, signal.chatId, sent.message_id);
    }

    logger.info(`Sent ${threshold}x alert for signal ${signal.id}`);
  } catch (error) {
    logger.error(`Error sending price alert:`, error);
  }
};

