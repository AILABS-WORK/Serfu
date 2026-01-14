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
        `*To add channels:*\n` +
        `1. Add the bot as admin to your channel\n` +
        `2. Run /addchannel <channel_id> here to claim ownership\n\n` +
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
              [
                { text: '📡 Add Channel', callback_data: 'channel_add' },
              ],
            ],
          },
        }
      );
    }

    const channels = groups.filter((g: any) => g.chatType === 'channel');
    const normalGroups = groups.filter((g: any) => g.chatType !== 'channel');

    // Fetch accurate signal counts by chatId (aggregating across all owner instances if needed, or just raw signals)
    const allChatIds = groups.map(g => g.chatId);
    const signalCounts = await (await import('../../db')).prisma.signal.groupBy({
        by: ['chatId'],
        _count: { id: true },
        where: { chatId: { in: allChatIds } }
    });
    const countMap = new Map(signalCounts.map(s => [s.chatId.toString(), s._count.id]));

    let message = '📋 *Your Monitored Groups*\n\n';
    
    for (const group of normalGroups) {
      const count = countMap.get(group.chatId.toString()) || 0;
      const status = group.isActive ? '✅' : '❌';
      const type = group.type === 'destination' ? '📤 Destination' : '📥 Source';
      message += `${status} *${group.name || `Group ${group.chatId}`}*\n`;
      message += `   Type: ${type}\n`;
      message += `   ID: \`${group.chatId}\`\n`;
      message += `   Signals: ${count}\n\n`;
    }

    if (channels.length > 0) {
      message += '📡 *Your Monitored Channels*\n\n';
      for (const ch of channels) {
        const count = countMap.get(ch.chatId.toString()) || 0;
        const status = ch.isActive ? '✅' : '❌';
        const type = ch.type === 'destination' ? '📤 Destination' : '📥 Source';
        message += `${status} *${ch.name || `Channel ${ch.chatId}`}*\n`;
        message += `   Type: ${type}\n`;
        message += `   ID: \`${ch.chatId}\`\n`;
        message += `   Signals: ${count}\n\n`;
      }
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
            { text: '📡 Add Channel', callback_data: 'channel_add' },
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
        chatType: (ctx.chat as any)?.type || undefined,
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

// Claim a channel as owned by the current user
export const handleAddChannelCommand = async (ctx: Context, channelIdentifier?: string) => {
  try {
    const userId = getCurrentUserId(ctx);
    if (!userId) {
      return ctx.reply('❌ Unable to identify user.');
    }

    if (!channelIdentifier) {
      return ctx.reply('Usage: /addchannel <channel_id_or_username>\nExample: /addchannel -100123456789 or /addchannel @mychannel');
    }

    let channelId: bigint;
    let channelTitle: string | undefined;

    // Handle @username
    if (channelIdentifier.startsWith('@')) {
        try {
            const chat = await ctx.telegram.getChat(channelIdentifier);
            if (!chat.id) throw new Error('No ID found');
            channelId = BigInt(chat.id);
            channelTitle = (chat as any).title;
        } catch (e) {
            return ctx.reply(`❌ Could not resolve ${channelIdentifier}. Please ensure the bot is an admin in the channel, or try using the numeric Channel ID.`);
        }
    } else {
        // Assume numeric ID
        try {
            // Validate it's a number
            if (!/^-?\d+$/.test(channelIdentifier)) throw new Error('Invalid ID format');
            channelId = BigInt(channelIdentifier);
            
            // Try to fetch info
             const chat = await ctx.telegram.getChat(Number(channelId)).catch(() => null);
             if (chat) channelTitle = (chat as any).title;
        } catch (e) {
             return ctx.reply('❌ Invalid Channel ID format.');
        }
    }

    // Ensure user exists
    await createOrUpdateUser(userId, {
      username: ctx.from?.username,
      firstName: ctx.from?.first_name,
      lastName: ctx.from?.last_name,
    });

    // Upsert the channel under this owner
    await createOrUpdateGroup(channelId, userId, {
      name: channelTitle || `Channel ${channelId}`,
      type: 'source',
      chatType: 'channel',
    });

    await ctx.reply(`✅ Channel \`${channelId}\` (${channelTitle || 'Unknown Title'}) claimed and added to your monitored list.`, { parse_mode: 'Markdown' });
  } catch (error) {
    logger.error('Error in /addchannel command:', error);
    ctx.reply('Error adding channel. Make sure the bot is an admin in the channel.');
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



