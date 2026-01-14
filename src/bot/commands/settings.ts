import { Context } from 'telegraf';
import { getOrCreateNotificationSettings, updateNotificationSettings } from '../../db/notifications';
import { updateChatPreferences } from '../../db/groups';
import { UIHelper } from '../../utils/ui';

const PRICE_FIELDS = ['alert2x','alert3x','alert4x','alert5x','alert10x','alert15x','alert20x','alert30x','alert50x','alert100x'] as const;
const MC_FIELDS = ['alertMc2x','alertMc3x','alertMc4x','alertMc5x','alertMc10x','alertMc15x','alertMc20x','alertMc30x','alertMc50x','alertMc100x'] as const;

const allEnabled = (obj: any, keys: readonly string[]) => keys.every(k => obj?.[k]);

export const handleSettingsCommand = async (ctx: Context) => {
  if (!ctx.from?.id) {
    return ctx.reply('Unable to determine user.');
  }

  // Detect context
  const isPrivate = ctx.chat?.type === 'private';
  const currentChatId = ctx.chat?.id ? BigInt(ctx.chat.id) : null;

  // 1. Fetch User Settings (Global)
  const settings = await getOrCreateNotificationSettings(ctx.from.id);
  const priceEnabled = allEnabled(settings, PRICE_FIELDS);
  const mcEnabled = allEnabled(settings, MC_FIELDS);
  const homeChat = settings.homeChatId ? `Chat ${settings.homeChatId}` : 'Not set';

  let message = '';
  let keyboard: any[] = [];

  if (isPrivate) {
      // --- GLOBAL USER SETTINGS ---
      message = UIHelper.header('Global Settings', '⚙️');
      message += UIHelper.subHeader('NOTIFICATIONS', '🔔');
      message += `• Price Alerts: ${priceEnabled ? '✅ ON' : '❌ OFF'}\n`;
      message += `• MC Alerts: ${mcEnabled ? '✅ ON' : '❌ OFF'}\n`;
      message += `• Home Alerts (First): ${settings.notifyHomeOnFirstCa ? '✅ ON' : '❌ OFF'}\n`;
      message += `• Home Alerts (Repost): ${settings.notifyHomeOnRepost ? '✅ ON' : '❌ OFF'}\n`;
      message += `• Home Chat: \`${homeChat}\`\n\n`;
      
      message += `_To configure a specific group, run /settings inside that group._`;

      keyboard = [
        [{ text: priceEnabled ? '🔕 Disable Price Alerts' : '🔔 Enable Price Alerts', callback_data: 'toggle_price_alerts' }],
        [{ text: mcEnabled ? '🔕 Disable MC Alerts' : '🔔 Enable MC Alerts', callback_data: 'toggle_mc_alerts' }],
        [{ text: settings.notifyHomeOnFirstCa ? '🏠 First→Home ON' : '🏠 First→Home OFF', callback_data: 'toggle_home_first' }],
        [{ text: settings.notifyHomeOnRepost ? '🆕 Reposts→Home ON' : '🆕 Reposts→Home OFF', callback_data: 'toggle_home_repost' }],
        [{ text: '❌ Close', callback_data: 'delete_msg' }]
      ];

  } else {
      // --- GROUP CONFIGURATION ---
      // Fetch group specific settings
      const { prisma } = await import('../../db');
      const group = await prisma.group.findFirst({ where: { chatId: currentChatId! } });
      const ttl = group?.autoDeleteSeconds || 'Off';
      const hideBtn = group?.showHideButton ? 'Shown' : 'Hidden';

      message = UIHelper.header('Group Configuration', '🛠️');
      message += `Target: *${ctx.chat?.title || 'This Group'}*\n`;
      message += UIHelper.separator('LIGHT');
      message += `• Auto-Delete (TTL): \`${ttl}\`\n`;
      message += `• Hide Button: \`${hideBtn}\`\n`;
      message += `• Home Chat: ${homeChat === currentChatId?.toString() ? '✅ THIS CHAT' : '❌ Other'}\n`;

      keyboard = [
        [{ text: '📍 Set as Home Chat', callback_data: 'set_home_here' }],
        [{ text: '⏳ TTL Off', callback_data: 'ttl_off' }, { text: '⏳ 30s', callback_data: 'ttl_30' }],
        [{ text: '⏳ 60s', callback_data: 'ttl_60' }, { text: '⏳ 180s', callback_data: 'ttl_180' }],
        [{ text: '🙈 Toggle Hide Button', callback_data: 'toggle_hide' }],
        [{ text: '❌ Close', callback_data: 'delete_msg' }]
      ];
  }

  // Send or Edit
  if (ctx.callbackQuery) {
      // If callback, we might need to handle "Refresh" which re-renders
      try {
        await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
      } catch (e) {
        // Fallback if message content is same
        await ctx.answerCbQuery('Settings updated');
      }
  } else {
      await ctx.reply(message, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
  }
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

