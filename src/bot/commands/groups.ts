import { Context } from 'telegraf';
import { 
  getAllGroups, 
  getGroupByChatId, 
  setGroupType, 
  toggleGroupActive,
  deleteGroup,
  createOrUpdateGroup,
  getBotInviteLink,
} from '../../db/groups';
import { getBotInstance } from '../instance';
import { logger } from '../../utils/logger';
import { createOrUpdateUser } from '../../db/users';

// Helper to get current user's Telegram ID
const getCurrentUserId = (ctx: Context): bigint | null => {
  return ctx.from?.id ? BigInt(ctx.from.id) : null;
};

export const handleGroupsCommand = async (ctx: Context) => {
  try {
    const userId = getCurrentUserId(ctx);
    if (!userId) {
      return ctx.reply('❌ Unable to identify user. Please try again.');
    }

    // Ensure user exists in DB
    await createOrUpdateUser(userId, {
      username: ctx.from?.username,
      firstName: ctx.from?.first_name,
      lastName: ctx.from?.last_name,
    });

    const groups = await getAllGroups(userId);
    
    if (groups.length === 0) {
      const bot = getBotInstance();
      const botInfo = await bot.telegram.getMe();
      const inviteLink = await getBotInviteLink(botInfo.username);
      
      return ctx.reply(
        `📋 *Your Groups*\n\n` +
        `No groups configured yet.\n\n` +
        `*How to add groups:*\n` +
        `1. Add bot to a group\n` +
        `2. Run /setdestination in that group (for destination)\n` +
        `3. Or the bot will auto-track groups it's added to\n\n` +
        `*Bot Invite Link:*\n` +
        `${inviteLink}\n\n` +
        `Share this link to add the bot to groups easily!`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '➕ Add Group', callback_data: 'group_add' },
                { text: '🔗 Get Invite Link', callback_data: 'group_invite' },
              ],
            ],
          },
        }
      );
    }

    let message = '📋 *Your Monitored Groups*\n\n';
    
    for (const group of groups) {
      const status = group.isActive ? '✅' : '❌';
      const type = group.type === 'destination' ? '📤 Destination' : '📥 Source';
      message += `${status} *${group.name || `Group ${group.chatId}`}*\n`;
      message += `   Type: ${type}\n`;
      message += `   ID: \`${group.chatId}\`\n`;
      message += `   Signals: ${group.signals?.length || 0}\n\n`;
    }

    await ctx.reply(message, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '➕ Add Group', callback_data: 'group_add' },
            { text: '🔗 Invite Link', callback_data: 'group_invite' },
          ],
          [
            { text: '⚙️ Settings', callback_data: 'group_settings' },
          ],
        ],
      },
    });
  } catch (error) {
    logger.error('Error in /groups command:', error);
    ctx.reply('Error fetching groups.');
  }
};

export const handleSetDestinationCommand = async (ctx: Context, groupIdStr?: string) => {
  try {
    const userId = getCurrentUserId(ctx);
    if (!userId) {
      return ctx.reply('❌ Unable to identify user.');
    }

    const chatId = ctx.chat?.id;
    
    if (!chatId) {
      return ctx.reply('This command must be used in a group.');
    }

    // Ensure user exists
    await createOrUpdateUser(userId, {
      username: ctx.from?.username,
      firstName: ctx.from?.first_name,
      lastName: ctx.from?.last_name,
    });

    const targetChatId = groupIdStr ? BigInt(groupIdStr) : BigInt(chatId);
    
    const group = await getGroupByChatId(targetChatId, userId);
    
    if (!group) {
      // Auto-create group if it doesn't exist
      await createOrUpdateGroup(targetChatId, userId, {
        name: (ctx.chat as any)?.title || undefined,
        type: 'destination',
      });
      return ctx.reply(`✅ This group is now set as YOUR destination for forwarded signals.\n\nOnly you will receive signals forwarded to this group.`);
    }

    await setGroupType(targetChatId, userId, 'destination');
    await ctx.reply(`✅ Group "${group.name || group.chatId}" is now set as YOUR destination for forwarded signals.`);
  } catch (error) {
    logger.error('Error in /setdestination command:', error);
    ctx.reply('Error setting destination group.');
  }
};

export const handleRemoveGroupCommand = async (ctx: Context, groupIdStr?: string) => {
  try {
    const userId = getCurrentUserId(ctx);
    if (!userId) {
      return ctx.reply('❌ Unable to identify user.');
    }

    const chatId = ctx.chat?.id;
    
    if (!chatId && !groupIdStr) {
      return ctx.reply('Please specify a group ID or use this command in a group.\nUsage: /removegroup <group_id>');
    }

    const targetChatId = groupIdStr ? BigInt(groupIdStr) : BigInt(chatId!);
    
    const group = await getGroupByChatId(targetChatId, userId);
    
    if (!group) {
      return ctx.reply('❌ Group not found. Make sure you own this group.');
    }

    await deleteGroup(targetChatId, userId);
    await ctx.reply(`✅ Group "${group.name || group.chatId}" has been removed from your monitoring.`);
  } catch (error) {
    logger.error('Error in /removegroup command:', error);
    ctx.reply('Error removing group.');
  }
};

export const handleToggleGroupCommand = async (ctx: Context, groupIdStr?: string) => {
  try {
    const userId = getCurrentUserId(ctx);
    if (!userId) {
      return ctx.reply('❌ Unable to identify user.');
    }

    const chatId = ctx.chat?.id;
    
    if (!chatId && !groupIdStr) {
      return ctx.reply('Please specify a group ID or use this command in a group.\nUsage: /togglegroup <group_id>');
    }

    const targetChatId = groupIdStr ? BigInt(groupIdStr) : BigInt(chatId!);
    
    const group = await getGroupByChatId(targetChatId, userId);
    
    if (!group) {
      return ctx.reply('❌ Group not found. Make sure you own this group.');
    }

    const newStatus = !group.isActive;
    await toggleGroupActive(targetChatId, userId, newStatus);
    
    await ctx.reply(
      `✅ Group "${group.name || group.chatId}" is now ${newStatus ? 'active' : 'inactive'}.`
    );
  } catch (error) {
    logger.error('Error in /togglegroup command:', error);
    ctx.reply('Error toggling group status.');
  }
};



