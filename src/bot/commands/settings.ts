import { Context } from 'telegraf';
import { getOrCreateNotificationSettings, updateNotificationSettings } from '../../db/notifications';
import { updateChatPreferences } from '../../db/groups';

const PRICE_FIELDS = ['alert2x','alert3x','alert4x','alert5x','alert10x','alert15x','alert20x','alert30x','alert50x','alert100x'] as const;
const MC_FIELDS = ['alertMc2x','alertMc3x','alertMc4x','alertMc5x','alertMc10x','alertMc15x','alertMc20x','alertMc30x','alertMc50x','alertMc100x'] as const;

const allEnabled = (obj: any, keys: readonly string[]) => keys.every(k => obj?.[k]);

export const handleSettingsCommand = async (ctx: Context) => {
  if (!ctx.from?.id) {
    return ctx.reply('Unable to determine user.');
  }

  const settings = await getOrCreateNotificationSettings(ctx.from.id);
  const priceEnabled = allEnabled(settings, PRICE_FIELDS);
  const mcEnabled = allEnabled(settings, MC_FIELDS);
  const homeChat = settings.homeChatId ? settings.homeChatId.toString() : 'Not set';
  const currentChatId = ctx.chat?.id ? BigInt(ctx.chat.id) : null;

  const message = [
    '⚙️ *Alerts & Settings*',
    '',
    `• Price alerts: ${priceEnabled ? 'ON' : 'OFF'} (2x-100x)`,
    `• MC alerts: ${mcEnabled ? 'ON' : 'OFF'} (2x-100x)`,
    `• Home alerts (first): ${settings.notifyHomeOnFirstCa ? 'ON' : 'OFF'}`,
    `• Home alerts (repost): ${settings.notifyHomeOnRepost ? 'ON' : 'OFF'}`,
    `• Home chat: ${homeChat}`,
    currentChatId ? `• Chat TTL/hide applies to: ${currentChatId}` : '',
    '',
    '_Toggles apply to all thresholds._',
  ].join('\n');

  await ctx.reply(message, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: priceEnabled ? '🔕 Disable Price Alerts' : '🔔 Enable Price Alerts', callback_data: 'toggle_price_alerts' }],
        [{ text: mcEnabled ? '🔕 Disable MC Alerts' : '🔔 Enable MC Alerts', callback_data: 'toggle_mc_alerts' }],
        [{ text: settings.notifyHomeOnFirstCa ? '🏠 First→Home ON' : '🏠 First→Home OFF', callback_data: 'toggle_home_first' }],
        [{ text: settings.notifyHomeOnRepost ? '🆕 Reposts→Home ON' : '🆕 Reposts→Home OFF', callback_data: 'toggle_home_repost' }],
        [{ text: '📍 Set Home to This Chat', callback_data: 'set_home_here' }],
        [{ text: '⏳ TTL Off', callback_data: 'ttl_off' }, { text: '⏳ 30s', callback_data: 'ttl_30' }],
        [{ text: '⏳ 60s', callback_data: 'ttl_60' }, { text: '⏳ 180s', callback_data: 'ttl_180' }],
        [{ text: '🙈 Toggle Hide', callback_data: 'toggle_hide' }],
        [{ text: '🔄 Refresh', callback_data: 'settings_menu' }],
      ],
    },
  });
};

export const togglePriceAlerts = async (userId: number) => {
  const settings = await getOrCreateNotificationSettings(userId);
  const priceEnabled = allEnabled(settings, PRICE_FIELDS);
  const newState = !priceEnabled;
  const data: Record<string, boolean> = {};
  PRICE_FIELDS.forEach((k) => (data[k] = newState));
  await updateNotificationSettings(userId, data);
  return newState;
};

export const toggleMcAlerts = async (userId: number) => {
  const settings = await getOrCreateNotificationSettings(userId);
  const mcEnabled = allEnabled(settings, MC_FIELDS);
  const newState = !mcEnabled;
  const data: Record<string, boolean> = {};
  MC_FIELDS.forEach((k) => (data[k] = newState));
  await updateNotificationSettings(userId, data);
  return newState;
};

export const toggleHomeFirst = async (userId: number) => {
  const settings = await getOrCreateNotificationSettings(userId);
  const newState = !settings.notifyHomeOnFirstCa;
  await updateNotificationSettings(userId, { notifyHomeOnFirstCa: newState });
  return newState;
};

export const toggleHomeRepost = async (userId: number) => {
  const settings = await getOrCreateNotificationSettings(userId);
  const newState = !settings.notifyHomeOnRepost;
  await updateNotificationSettings(userId, { notifyHomeOnRepost: newState });
  return newState;
};

export const setHomeChat = async (userId: number, chatId: bigint) => {
  await updateNotificationSettings(userId, { homeChatId: chatId });
  return chatId;
};

// Chat-level anti-spam preferences (per chat, owned)
export const setTtl = async (ctx: Context, seconds: number | null) => {
  if (!ctx.from?.id || !ctx.chat?.id) {
    return ctx.reply('Cannot set TTL here.');
  }
  const chatId = BigInt(ctx.chat.id);
  await updateChatPreferences(chatId, BigInt(ctx.from.id), { autoDeleteSeconds: seconds });
  await ctx.reply(seconds && seconds > 0 ? `TTL set to ${seconds}s for this chat.` : 'Auto-delete disabled for this chat.');
};

export const toggleHideForChat = async (ctx: Context) => {
  if (!ctx.from?.id || !ctx.chat?.id) {
    return ctx.reply('Cannot toggle hide here.');
  }
  const chatId = BigInt(ctx.chat.id);
  await updateChatPreferences(chatId, BigInt(ctx.from.id), { showHideButton: true }); // ensure exists
  const { prisma } = await import('../../db');
  const group = await prisma.group.findFirst({ where: { chatId, owner: { userId: BigInt(ctx.from.id) } } });
  const current = group?.showHideButton ?? true;
  await updateChatPreferences(chatId, BigInt(ctx.from.id), { showHideButton: !current });
  await ctx.reply(`Hide button is now ${!current ? 'ENABLED' : 'DISABLED'} for this chat.`);
};

