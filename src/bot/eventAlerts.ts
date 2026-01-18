import { Telegraf } from 'telegraf';
import { prisma } from '../db';
import { getDestinationGroups } from '../db/groups';
import { scheduleAutoDelete } from '../utils/messageCleanup';
import { logger } from '../utils/logger';

type EventType = 'dex_payment' | 'bonding' | 'migrating';

const eventLabels: Record<EventType, string> = {
  dex_payment: 'DEX Payment',
  bonding: 'Bonding',
  migrating: 'Migrating',
};

export const detectEvents = (text?: string): EventType[] => {
  if (!text) return [];
  const lower = text.toLowerCase();
  const events: EventType[] = [];
  if (/(dex\s*paid|dex\s*payment|tax\s*paid)/i.test(lower)) events.push('dex_payment');
  if (/bonding/i.test(lower)) events.push('bonding');
  if (/migrating|migration/i.test(lower)) events.push('migrating');
  return events;
};

export const sendEventAlerts = async (params: {
  bot: Telegraf;
  ownerTelegramId: bigint;
  sourceChatId: bigint;
  sourceName: string;
  textSnippet: string;
  settings: any; // UserNotificationSettings
  events: EventType[];
}) => {
  try {
    const { bot, ownerTelegramId, sourceChatId, sourceName, textSnippet, settings, events } = params;
    const destinations = settings.notifyDestination
      ? await getDestinationGroups(ownerTelegramId)
      : [];

    const homeChatId = settings.homeChatId;

    const messageLines = events.map((e) => `• ${eventLabels[e]}`).join('\n');
    const message = `
⚠️ *Event Alert*

${messageLines}
*Source:* ${sourceName}
*Excerpt:* ${textSnippet}
    `.trim();

    const sendWithPrefs = async (chatId: bigint, autoDeleteSeconds?: number | null) => {
      const sent = await bot.telegram.sendMessage(Number(chatId), message, { parse_mode: 'Markdown' });
      scheduleAutoDelete(bot, chatId, sent.message_id, autoDeleteSeconds ?? null);
    };

    // Destinations
    for (const dest of destinations) {
      await sendWithPrefs(dest.chatId, dest.autoDeleteSeconds ?? null);
    }

    // Home
    if (homeChatId && (settings.notifyHomeOnFirstCa || settings.notifyHomeOnRepost)) {
      await sendWithPrefs(homeChatId);
    }
  } catch (error) {
    logger.error('Error sending event alerts:', error);
  }
};










