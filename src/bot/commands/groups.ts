import { Context } from 'telegraf';
import { 
  getAllGroups, 
  getGroupByChatId, 
  setGroupType, 
  toggleGroupActive,
  deleteGroup,
  createOrUpdateGroup,
} from '../../db/groups';
import { logger } from '../../utils/logger';

export const handleGroupsCommand = async (ctx: Context) => {
  try {
    const groups = await getAllGroups();
    
    if (groups.length === 0) {
      return ctx.reply('No groups configured yet. Add the bot to a group to start monitoring.');
    }

    let message = '📋 *Monitored Groups*\n\n';
    
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
    const chatId = ctx.chat?.id;
    
    if (!chatId) {
      return ctx.reply('This command must be used in a group.');
    }

    const targetChatId = groupIdStr ? BigInt(groupIdStr) : BigInt(chatId);
    
    const group = await getGroupByChatId(targetChatId);
    
    if (!group) {
      // Auto-create group if it doesn't exist
      await createOrUpdateGroup(targetChatId, {
        name: (ctx.chat as any)?.title || undefined,
        type: 'destination',
      });
      return ctx.reply(`✅ This group is now set as a destination for forwarded signals.`);
    }

    await setGroupType(targetChatId, 'destination');
    await ctx.reply(`✅ Group "${group.name || group.chatId}" is now set as a destination for forwarded signals.`);
  } catch (error) {
    logger.error('Error in /setdestination command:', error);
    ctx.reply('Error setting destination group.');
  }
};

export const handleRemoveGroupCommand = async (ctx: Context, groupIdStr?: string) => {
  try {
    const chatId = ctx.chat?.id;
    
    if (!chatId) {
      return ctx.reply('This command must be used in a group.');
    }

    const targetChatId = groupIdStr ? BigInt(groupIdStr) : BigInt(chatId);
    
    const group = await getGroupByChatId(targetChatId);
    
    if (!group) {
      return ctx.reply('Group not found.');
    }

    await deleteGroup(targetChatId);
    await ctx.reply(`✅ Group "${group.name || group.chatId}" has been removed from monitoring.`);
  } catch (error) {
    logger.error('Error in /removegroup command:', error);
    ctx.reply('Error removing group.');
  }
};

export const handleToggleGroupCommand = async (ctx: Context, groupIdStr?: string) => {
  try {
    const chatId = ctx.chat?.id;
    
    if (!chatId) {
      return ctx.reply('This command must be used in a group.');
    }

    const targetChatId = groupIdStr ? BigInt(groupIdStr) : BigInt(chatId);
    
    const group = await getGroupByChatId(targetChatId);
    
    if (!group) {
      return ctx.reply('Group not found.');
    }

    const newStatus = !group.isActive;
    await toggleGroupActive(targetChatId, newStatus);
    
    await ctx.reply(
      `✅ Group "${group.name || group.chatId}" is now ${newStatus ? 'active' : 'inactive'}.`
    );
  } catch (error) {
    logger.error('Error in /togglegroup command:', error);
    ctx.reply('Error toggling group status.');
  }
};


