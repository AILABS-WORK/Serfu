import { prisma } from '../db';
import { provider } from '../providers';
import { logger } from '../utils/logger';
import { getBotInstance } from '../bot/instance';
import { scheduleAutoDelete } from '../utils/messageCleanup';
import { getChatPreferences } from '../db/groups';

// Multipliers to check
const PRICE_MULTIPLIERS = [2, 3, 4, 5, 10, 15, 20, 30, 50, 100];
const MC_MULTIPLIERS = [2, 3, 4, 5, 10, 15, 20, 30, 50, 100];

// Track which alerts have been sent (price and MC) to avoid duplicates
// Keys are strings like "price_2" or "mc_5"
const sentAlerts = new Map<number, Set<string>>(); // signalId -> Set of alert keys

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

        // Ensure alert set
        if (!sentAlerts.has(signal.id)) {
          sentAlerts.set(signal.id, new Set());
        }
        const sentKeys = sentAlerts.get(signal.id)!;

        // Price thresholds
        for (const threshold of PRICE_MULTIPLIERS) {
          const key = `price_${threshold}`;
          if (multiplier >= threshold && !sentKeys.has(key)) {
            const alertEnabled = getAlertEnabled(settings, threshold, 'price');
            if (alertEnabled) {
              await sendPriceAlert(signal, threshold, currentPrice, multiplier);
            }
            sentKeys.add(key);
          }
        }

        // MC thresholds (requires entry MC and a supply estimate)
        const entryMc = signal.entryMarketCap ?? (signal.entryPrice && signal.entrySupply ? signal.entryPrice * signal.entrySupply : null);
        if (entryMc && signal.entrySupply) {
          const currentMc = currentPrice * signal.entrySupply;
          const mcMultiple = currentMc / entryMc;
          for (const threshold of MC_MULTIPLIERS) {
            const key = `mc_${threshold}`;
            if (mcMultiple >= threshold && !sentKeys.has(key)) {
              const alertEnabled = getAlertEnabled(settings, threshold, 'mc');
              if (alertEnabled) {
                await sendMcAlert(signal, threshold, {
                  currentPrice,
                  currentMc,
                  multiplier: mcMultiple,
                  entryMc,
                });
              }
              sentKeys.add(key);
            }
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

const getAlertEnabled = (settings: any, multiplier: number, type: 'price' | 'mc'): boolean => {
  if (type === 'mc') {
    switch (multiplier) {
      case 2: return settings.alertMc2x;
      case 3: return settings.alertMc3x;
      case 4: return settings.alertMc4x;
      case 5: return settings.alertMc5x;
      case 10: return settings.alertMc10x;
      case 15: return settings.alertMc15x;
      case 20: return settings.alertMc20x;
      case 30: return settings.alertMc30x;
      case 50: return settings.alertMc50x;
      case 100: return settings.alertMc100x;
      default: return false;
    }
  }

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
        const prefs = await getChatPreferences(dest.chatId);
        const sent = await bot.telegram.sendMessage(Number(dest.chatId), message, {
          parse_mode: 'Markdown',
          reply_markup: prefs.showHideButton ? { inline_keyboard: [[{ text: '🙈 Hide', callback_data: 'hide' }]] } : undefined,
        });
        scheduleAutoDelete(bot, dest.chatId, sent.message_id, prefs.autoDeleteSeconds ?? dest.autoDeleteSeconds ?? null);
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
    const prefs = await getChatPreferences(BigInt(signal.chatId));
    const sent = await bot.telegram.sendMessage(Number(signal.chatId), message, {
        parse_mode: 'Markdown',
        reply_markup: prefs.showHideButton ? { inline_keyboard: [[{ text: '🙈 Hide', callback_data: 'hide' }]] } : undefined,
      });
    scheduleAutoDelete(bot, signal.chatId, sent.message_id, prefs.autoDeleteSeconds ?? null);
    }

    logger.info(`Sent ${threshold}x alert for signal ${signal.id}`);
  } catch (error) {
    logger.error(`Error sending price alert:`, error);
  }
};

const sendMcAlert = async (
  signal: any,
  threshold: number,
  info: { currentPrice: number; currentMc: number; multiplier: number; entryMc: number }
) => {
  try {
    const bot = getBotInstance();
    const settings = signal.user?.notificationSettings || 
                    signal.group?.owner?.notificationSettings;

    if (!settings) return;

    const message = `
🚨 *MC ALERT: ${threshold}x REACHED*

*Token:* ${signal.name || 'Unknown'} (${signal.symbol || 'N/A'})
*Mint:* \`${signal.mint}\`
*Entry MC:* $${info.entryMc.toFixed(2)}
*Current MC:* $${info.currentMc.toFixed(2)}
*Current Price:* $${info.currentPrice.toFixed(6)}
*Multiplier:* ${info.multiplier.toFixed(2)}x

[View on Solscan](https://solscan.io/token/${signal.mint})
    `;

    // Send to destination groups if enabled
    if (settings.notifyDestination && signal.group?.owner?.userId) {
      const { getDestinationGroups } = await import('../db/groups');
      const ownerTelegramId = signal.group.owner.userId;
      const destinations = await getDestinationGroups(ownerTelegramId);
      for (const dest of destinations) {
        const prefs = await getChatPreferences(dest.chatId);
        const sent = await bot.telegram.sendMessage(Number(dest.chatId), message, {
          parse_mode: 'Markdown',
          reply_markup: prefs.showHideButton ? { inline_keyboard: [[{ text: '🙈 Hide', callback_data: 'hide' }]] } : undefined,
        });
        scheduleAutoDelete(bot, dest.chatId, sent.message_id, prefs.autoDeleteSeconds ?? dest.autoDeleteSeconds ?? null);
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
      const prefs = await getChatPreferences(BigInt(signal.chatId));
      const sent = await bot.telegram.sendMessage(Number(signal.chatId), message, {
        parse_mode: 'Markdown',
        reply_markup: prefs.showHideButton ? { inline_keyboard: [[{ text: '🙈 Hide', callback_data: 'hide' }]] } : undefined,
      });
      scheduleAutoDelete(bot, signal.chatId, sent.message_id, prefs.autoDeleteSeconds ?? null);
    }

    // Send to home chat if configured and allowed (reuse repost toggle)
    if (settings.homeChatId) {
      const allowHome = settings.notifyHomeOnRepost || settings.notifyHomeOnFirstCa;
      if (allowHome && settings.homeChatId !== signal.chatId) {
        const prefs = await getChatPreferences(BigInt(settings.homeChatId));
        const sent = await bot.telegram.sendMessage(Number(settings.homeChatId), message, {
          parse_mode: 'Markdown',
          reply_markup: prefs.showHideButton ? { inline_keyboard: [[{ text: '🙈 Hide', callback_data: 'hide' }]] } : undefined,
        });
        scheduleAutoDelete(bot, settings.homeChatId, sent.message_id, prefs.autoDeleteSeconds ?? null);
      }
    }

    logger.info(`Sent MC ${threshold}x alert for signal ${signal.id}`);
  } catch (error) {
    logger.error(`Error sending MC alert:`, error);
  }
};

