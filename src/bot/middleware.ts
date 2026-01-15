import { Context, Middleware } from 'telegraf';
import { createRawMessage } from '../db/messages';
import { processMessage } from '../ingest/processor';
import { createOrUpdateGroup, getAnyGroupByChatId } from '../db/groups';
import { createOrUpdateUser } from '../db/users';
import { logger } from '../utils/logger';
import { UIHelper } from '../utils/ui';
import { prisma } from '../db';
import { isAwaitChannelClaim, clearAwaitChannelClaim } from './state/channelClaimState';

export const ingestMiddleware: Middleware<Context> = async (ctx, next) => {
  // We process messages from groups, supergroups, and channels
  // PRD says: "For every message in the group, store at minimum..."
  
  // Handle bot being added to a group/channel (my_chat_member update)
  if (ctx.myChatMember) {
    const status = ctx.myChatMember.new_chat_member.status;
    const oldStatus = ctx.myChatMember.old_chat_member.status;
    const isJoin = (status === 'member' || status === 'administrator') && (oldStatus === 'left' || oldStatus === 'kicked' || oldStatus === 'restricted');
    
    if (isJoin && ctx.from) {
      const chatId = BigInt(ctx.chat?.id || 0);
      const userId = BigInt(ctx.from.id);
      const chatTitle = (ctx.chat as any)?.title || `Group ${chatId}`;
      const chatType = (ctx.chat as any)?.type;

      if (chatId !== 0n) {
        try {
          // Auto-register this group as a source for the user who added the bot
          await createOrUpdateGroup(chatId, userId, {
            name: chatTitle,
            type: 'source',
            chatType: chatType,
          });
          logger.info(`Bot added to chat ${chatId} by user ${userId}. Registered as source group.`);
          
          // Optional: Send a welcome message confirming setup
          if (chatType === 'group' || chatType === 'supergroup') {
              // Only reply if we have permission to send messages
              try {
                  await ctx.reply('👋 Hello! I am now monitoring this group for signals.\nUse /groups to manage your settings.');
              } catch (e) {
                  // Ignore if can't send messages
              }
          }
        } catch (error) {
          logger.error('Error handling my_chat_member update:', error);
        }
      }
    }
    return next();
  }

  // Guided channel claim flow (only in private chats). Also auto-claim if a forwarded channel message is sent.
  if (ctx.chat?.type === 'private' && ctx.from?.id) {
    const pending = (ctx as any).session?.pendingInput;
    const text = (ctx.message as any)?.text || '';

    if (pending?.type && text) {
      const parsed = UIHelper.parseTimeframeInput(text);
      (ctx as any).session.pendingInput = undefined;
      if (!parsed) {
        await ctx.reply('❌ Invalid timeframe. Use 6H, 3D, 2W, 1M.');
        return next();
      }

      if (pending.type === 'dist_timeframe') {
        if (!(ctx as any).session.distributions) (ctx as any).session.distributions = {};
        (ctx as any).session.distributions.timeframe = parsed.label;

        const lastChatId = (ctx as any).session.distributions.lastChatId;
        const lastMessageId = (ctx as any).session.distributions.lastMessageId;
        if (lastChatId && lastMessageId) {
          try {
            const { handleDistributions } = await import('./commands/analytics');
            await handleDistributions(ctx as any, 'mcap');
            return next();
          } catch (err) {
            logger.warn('Failed to refresh distributions after custom timeframe:', err);
          }
        }
        await ctx.reply(`✅ Timeframe set to ${parsed.label}. Open Distributions to refresh.`);
        return next();
      }

      if (pending.type === 'leaderboard_groups') {
        if (!(ctx as any).session.leaderboards) (ctx as any).session.leaderboards = {};
        (ctx as any).session.leaderboards.group = parsed.label;
        const { handleGroupLeaderboardCommand } = await import('./commands/analytics');
        await handleGroupLeaderboardCommand(ctx as any, parsed.label as any);
        return next();
      }

      if (pending.type === 'leaderboard_users') {
        if (!(ctx as any).session.leaderboards) (ctx as any).session.leaderboards = {};
        (ctx as any).session.leaderboards.user = parsed.label;
        const { handleUserLeaderboardCommand } = await import('./commands/analytics');
        await handleUserLeaderboardCommand(ctx as any, parsed.label as any);
        return next();
      }

      if (pending.type === 'leaderboard_signals') {
        if (!(ctx as any).session.leaderboards) (ctx as any).session.leaderboards = {};
        (ctx as any).session.leaderboards.signal = parsed.label;
        const { handleSignalLeaderboardCommand } = await import('./commands/analytics');
        await handleSignalLeaderboardCommand(ctx as any, parsed.label as any);
        return next();
      }

      if (pending.type === 'recent_timeframe') {
        if (!(ctx as any).session.recent) (ctx as any).session.recent = {};
        (ctx as any).session.recent.timeframe = parsed.label;
        const { handleRecentCalls } = await import('./commands/analytics');
        await handleRecentCalls(ctx as any, parsed.label as any);
        return next();
      }

      if (pending.type === 'group_stats_timeframe' && pending.groupId) {
        if (!(ctx as any).session.stats) (ctx as any).session.stats = {};
        if (!(ctx as any).session.stats.group) (ctx as any).session.stats.group = {};
        (ctx as any).session.stats.group[pending.groupId] = parsed.label;
        const { handleGroupStatsCommand } = await import('./commands/analytics');
        await handleGroupStatsCommand(ctx as any, pending.groupId.toString(), parsed.label as any);
        return next();
      }

      if (pending.type === 'user_stats_timeframe' && pending.userId) {
        if (!(ctx as any).session.stats) (ctx as any).session.stats = {};
        if (!(ctx as any).session.stats.user) (ctx as any).session.stats.user = {};
        (ctx as any).session.stats.user[pending.userId] = parsed.label;
        const { handleUserStatsCommand } = await import('./commands/analytics');
        await handleUserStatsCommand(ctx as any, pending.userId.toString(), parsed.label as any);
        return next();
      }

      if (pending.type === 'strategy_timeframe') {
        if (!(ctx as any).session.strategyDraft) (ctx as any).session.strategyDraft = {};
        (ctx as any).session.strategyDraft.timeframe = parsed.label;
        const { handleStrategyDraftSummary } = await import('./commands/copyTrading');
        await handleStrategyDraftSummary(ctx as any);
        return next();
      }

      if (pending.type === 'strategy_time_window') {
        const windowMatch = text.trim().match(/^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
        if (!windowMatch) {
          await ctx.reply('❌ Invalid time window. Use HH:MM-HH:MM (e.g., 09:30-14:00).');
          return next();
        }
        if (!(ctx as any).session.strategyDraft) (ctx as any).session.strategyDraft = {};
        if (!(ctx as any).session.strategyDraft.schedule) (ctx as any).session.strategyDraft.schedule = { timezone: 'UTC', windows: [], days: [] };
        const schedule = (ctx as any).session.strategyDraft.schedule;
        schedule.windows = schedule.windows || [];
        schedule.windows.push({ start: windowMatch[1], end: windowMatch[2] });
        const { handleStrategyScheduleView } = await import('./commands/copyTrading');
        await handleStrategyScheduleView(ctx as any);
        return next();
      }

      if (pending.type === 'strategy_cond_volume') {
        const val = UIHelper.parseCompactNumber(text);
        if (val === null) {
          await ctx.reply('❌ Invalid volume. Use numbers like 25000, 25K, 1.2M.');
          return next();
        }
        if (!(ctx as any).session.strategyDraft) (ctx as any).session.strategyDraft = {};
        if (!(ctx as any).session.strategyDraft.conditions) (ctx as any).session.strategyDraft.conditions = {};
        (ctx as any).session.strategyDraft.conditions.minVolume = val;
        const { handleStrategyConditionsView } = await import('./commands/copyTrading');
        await handleStrategyConditionsView(ctx as any);
        return next();
      }

      if (pending.type === 'strategy_cond_mentions') {
        const num = parseInt(text.trim(), 10);
        if (!num || num < 0) {
          await ctx.reply('❌ Invalid mentions count. Use a whole number.');
          return next();
        }
        if (!(ctx as any).session.strategyDraft) (ctx as any).session.strategyDraft = {};
        if (!(ctx as any).session.strategyDraft.conditions) (ctx as any).session.strategyDraft.conditions = {};
        (ctx as any).session.strategyDraft.conditions.minMentions = num;
        const { handleStrategyConditionsView } = await import('./commands/copyTrading');
        await handleStrategyConditionsView(ctx as any);
        return next();
      }

      if (pending.type === 'strategy_cond_min_mc') {
        const val = UIHelper.parseCompactNumber(text);
        if (val === null) {
          await ctx.reply('❌ Invalid market cap. Use numbers like 15000, 120K, 1.2M.');
          return next();
        }
        if (!(ctx as any).session.strategyDraft) (ctx as any).session.strategyDraft = {};
        if (!(ctx as any).session.strategyDraft.conditions) (ctx as any).session.strategyDraft.conditions = {};
        (ctx as any).session.strategyDraft.conditions.minMarketCap = val;
        const { handleStrategyConditionsView } = await import('./commands/copyTrading');
        await handleStrategyConditionsView(ctx as any);
        return next();
      }

      if (pending.type === 'strategy_cond_max_mc') {
        const val = UIHelper.parseCompactNumber(text);
        if (val === null) {
          await ctx.reply('❌ Invalid market cap. Use numbers like 15000, 120K, 1.2M.');
          return next();
        }
        if (!(ctx as any).session.strategyDraft) (ctx as any).session.strategyDraft = {};
        if (!(ctx as any).session.strategyDraft.conditions) (ctx as any).session.strategyDraft.conditions = {};
        (ctx as any).session.strategyDraft.conditions.maxMarketCap = val;
        const { handleStrategyConditionsView } = await import('./commands/copyTrading');
        await handleStrategyConditionsView(ctx as any);
        return next();
      }

      if (pending.type === 'strategy_cond_tp') {
        const val = parseFloat(text.trim());
        if (!val || val <= 1) {
          await ctx.reply('❌ Invalid take profit multiple. Use a number > 1 (e.g., 2.5).');
          return next();
        }
        if (!(ctx as any).session.strategyDraft) (ctx as any).session.strategyDraft = {};
        if (!(ctx as any).session.strategyDraft.conditions) (ctx as any).session.strategyDraft.conditions = {};
        (ctx as any).session.strategyDraft.conditions.takeProfitMultiple = val;
        const { handleStrategyConditionsView } = await import('./commands/copyTrading');
        await handleStrategyConditionsView(ctx as any);
        return next();
      }

      if (pending.type === 'strategy_cond_sl') {
        const val = parseFloat(text.trim());
        if (val === null || Number.isNaN(val) || val <= 0 || val >= 1) {
          await ctx.reply('❌ Invalid stop loss multiple. Use a number between 0 and 1 (e.g., 0.7).');
          return next();
        }
        if (!(ctx as any).session.strategyDraft) (ctx as any).session.strategyDraft = {};
        if (!(ctx as any).session.strategyDraft.conditions) (ctx as any).session.strategyDraft.conditions = {};
        (ctx as any).session.strategyDraft.conditions.stopLossMultiple = val;
        const { handleStrategyConditionsView } = await import('./commands/copyTrading');
        await handleStrategyConditionsView(ctx as any);
        return next();
      }

      if (pending.type === 'strategy_cond_tp_rule' || pending.type === 'strategy_cond_sl_rule') {
        const match = text.trim().match(/^(\d+(\.\d+)?)x(?:\s+(\d+)%?)?(?:\s+(\d+)?m)?$/i);
        if (!match) {
          await ctx.reply('❌ Invalid format. Use like "4x 50% 1m" or "3x".');
          return next();
        }
        const multiple = parseFloat(match[1]);
        const pct = match[3] ? parseInt(match[3], 10) : undefined;
        const minutes = match[4] ? parseInt(match[4], 10) : undefined;
        if (pending.type === 'strategy_cond_tp_rule' && multiple <= 1) {
          await ctx.reply('❌ TP multiple must be > 1.');
          return next();
        }
        if (pending.type === 'strategy_cond_sl_rule' && (multiple <= 0 || multiple >= 1)) {
          await ctx.reply('❌ SL multiple must be between 0 and 1.');
          return next();
        }
        if (pct !== undefined && (pct <= 0 || pct > 100)) {
          await ctx.reply('❌ Percent must be 1-100.');
          return next();
        }
        if (minutes !== undefined && minutes <= 0) {
          await ctx.reply('❌ Minutes must be > 0.');
          return next();
        }
        if (!(ctx as any).session.strategyDraft) (ctx as any).session.strategyDraft = {};
        if (!(ctx as any).session.strategyDraft.conditions) (ctx as any).session.strategyDraft.conditions = {};
        const key = pending.type === 'strategy_cond_tp_rule' ? 'takeProfitRules' : 'stopLossRules';
        const rules = (ctx as any).session.strategyDraft.conditions[key] || [];
        rules.push({ multiple, maxMinutes: minutes, sellPct: pct ? pct / 100 : undefined });
        (ctx as any).session.strategyDraft.conditions[key] = rules;
        const { handleStrategyConditionsView } = await import('./commands/copyTrading');
        await handleStrategyConditionsView(ctx as any);
        return next();
      }
      if (pending.type === 'strategy_balance') {
        const val = parseFloat(text.trim());
        if (!val || val <= 0) {
          await ctx.reply('❌ Invalid balance. Use a number like 1 or 2.5 (SOL).');
          return next();
        }
        if (!(ctx as any).session.strategyDraft) (ctx as any).session.strategyDraft = {};
        (ctx as any).session.strategyDraft.startBalanceSol = val;
        const { handleStrategyDraftSummary } = await import('./commands/copyTrading');
        await handleStrategyDraftSummary(ctx as any);
        return next();
      }

      if (pending.type === 'preset_tp_rule' || pending.type === 'preset_sl_rule') {
        const presetId = pending.presetId;
        if (!presetId) return next();
        const match = text.trim().match(/^(\d+(\.\d+)?)x(?:\s+(\d+)%?)?(?:\s+(\d+)?m)?$/i);
        if (!match) {
          await ctx.reply('❌ Invalid format. Use like "4x 50% 1m" or "0.7x 50%".');
          return next();
        }
        const multiple = parseFloat(match[1]);
        const pct = match[3] ? parseInt(match[3], 10) : undefined;
        const minutes = match[4] ? parseInt(match[4], 10) : undefined;
        if (pending.type === 'preset_tp_rule' && multiple <= 1) {
          await ctx.reply('❌ TP multiple must be > 1.');
          return next();
        }
        if (pending.type === 'preset_sl_rule' && (multiple <= 0 || multiple >= 1)) {
          await ctx.reply('❌ SL multiple must be between 0 and 1.');
          return next();
        }
        if (pct !== undefined && (pct <= 0 || pct > 100)) {
          await ctx.reply('❌ Percent must be 1-100.');
          return next();
        }
        if (minutes !== undefined && minutes <= 0) {
          await ctx.reply('❌ Minutes must be > 0.');
          return next();
        }
        const ownerTelegramId = ctx.from?.id ? BigInt(ctx.from.id) : null;
        if (!ownerTelegramId) return next();
        const owner = await prisma.user.findUnique({ where: { userId: ownerTelegramId } });
        if (!owner) return next();
        const preset = await prisma.strategyPreset.findFirst({ where: { id: presetId, ownerId: owner.id } });
        if (!preset) return next();
        const conditions: any = preset.conditions || {};
        const key = pending.type === 'preset_tp_rule' ? 'takeProfitRules' : 'stopLossRules';
        const rules = conditions[key] || [];
        rules.push({ multiple, maxMinutes: minutes, sellPct: pct ? pct / 100 : undefined });
        conditions[key] = rules;
        await prisma.strategyPreset.update({ where: { id: preset.id }, data: { conditions } });
        await ctx.reply('✅ Rule added to preset.');
        return next();
      }

      if (pending.type === 'strategy_fee') {
        const val = parseFloat(text.trim());
        if (val === null || Number.isNaN(val) || val < 0) {
          await ctx.reply('❌ Invalid fee. Use a number like 0.0001 (SOL).');
          return next();
        }
        if (!(ctx as any).session.strategyDraft) (ctx as any).session.strategyDraft = {};
        (ctx as any).session.strategyDraft.feePerSideSol = val;
        const { handleStrategyDraftSummary } = await import('./commands/copyTrading');
        await handleStrategyDraftSummary(ctx as any);
        return next();
      }
    }

    const awaiting = isAwaitChannelClaim(ctx.from.id);
    const fwdChat = (ctx.message as any)?.forward_from_chat;
    let channelId: bigint | null = null;
    let channelTitle: string | undefined;

    if (fwdChat?.type === 'channel' && fwdChat?.id) {
      channelId = BigInt(fwdChat.id);
      channelTitle = fwdChat.title;
    } else if (text && text.startsWith('@')) {
      try {
        const chat = await ctx.telegram.getChat(text);
        if ((chat as any).type === 'channel' && (chat as any).id) {
          channelId = BigInt((chat as any).id);
          channelTitle = (chat as any).title;
        }
      } catch (err) {
        if (awaiting) logger.debug('Failed to resolve channel username:', err);
      }
    }

    if (awaiting || channelId) {
      if (!channelId) {
        await ctx.reply('❌ Please forward a message from the channel or send its @username.');
        return next();
      }
      try {
        await createOrUpdateGroup(channelId, BigInt(ctx.from.id), {
          name: channelTitle || `Channel ${channelId}`,
          type: 'source',
          chatType: 'channel',
        });
        clearAwaitChannelClaim(ctx.from.id);
        await ctx.reply(`✅ Channel claimed: \`${channelId}\`\nRun /groups to verify.`, { parse_mode: 'Markdown' });
      } catch (err) {
        logger.error('Error during channel claim flow:', err);
        await ctx.reply('❌ Could not claim channel. Make sure the bot is admin, then try again.');
      }
      return next();
    }
  }
  
  // Handle channel posts separately (channels have different structure in Telegraf)
  const channelPost = (ctx as any).channelPost;
  if (channelPost && typeof channelPost === 'object' && 'text' in channelPost) {
    try {
      const message = channelPost as any;
      const chatId = message.chat?.id;
      const messageId = message.message_id;
      const messageDate = message.date;
      
      // Safety: Skip messages older than 2 minutes to prevent spam on restart
      if (Date.now() / 1000 - messageDate > 120) {
          logger.debug(`Skipping old channel post ${messageId} from ${chatId} (age: ${Math.round(Date.now()/1000 - messageDate)}s)`);
          return next();
      }

      const senderId = message.from?.id || null; // Channels might not have senderId
      const senderUsername = message.from?.username;
      const sentAt = new Date(message.date * 1000);
      const rawText = message.text;
      
      if (!chatId || !messageId) {
        return next();
      }
      
      // Find existing claimed channel (any owner)
      const existing = await getAnyGroupByChatId(BigInt(chatId));

      // Create user if sender exists
      let userId: number | null = null;
      if (message.from?.id) {
        const user = await createOrUpdateUser(BigInt(message.from.id), {
          username: senderUsername,
          firstName: message.from?.first_name,
          lastName: message.from?.last_name,
        });
        userId = user.id;
      }
      
      // Create or reuse channel record:
      // - If existing claimed channel, reuse it
      // - Else if sender exists, claim for sender
      // - Else skip creation (needs /addchannel)
      let groupId: number | null = existing?.id || null;
      if (!groupId) {
        if (senderId) {
          try {
            const group = await createOrUpdateGroup(BigInt(chatId), BigInt(senderId), {
              name: message.chat?.title || `Channel ${chatId}`,
              type: 'source',
              chatType: 'channel',
            });
            groupId = group.id;
          } catch (error) {
            logger.debug(`Could not create channel for chat ${chatId}:`, error);
          }
        } else {
          logger.debug(`Channel ${chatId} not claimed and no senderId; skipping group creation. Use /addchannel <id> to claim.`);
        }
      }
      
      // Store message
      const rawMessage = await createRawMessage({
        chatId: BigInt(chatId),
        messageId,
        senderId: message.from?.id ? BigInt(message.from.id) : null,
        senderUsername,
        sentAt,
        rawText,
        isSignal: false,
        ...(groupId ? { group: { connect: { id: groupId } } } : {}),
        ...(userId ? { user: { connect: { id: userId } } } : {}),
      });
      
      logger.debug(`Ingested channel message ${messageId} from ${chatId}`);
      await processMessage(rawMessage);
    } catch (error) {
      logger.error('Error ingesting channel message:', error);
    }
    return next();
  }
  
  // Skip private chats (DMs) - only process groups/supergroups
  if (ctx.message && 'text' in ctx.message) {
    const chatType = (ctx.message.chat as any).type;
    if (chatType === 'private') {
      return next(); // Skip DMs
    }
    try {
      const message = ctx.message;
      const chatId = message.chat.id;
      const messageId = message.message_id;
      
      // Safety: Skip old messages (2 mins)
      if (Date.now() / 1000 - message.date > 120) {
          return next();
      }

      const senderId = message.from?.id;
      const senderUsername = message.from?.username;
      const sentAt = new Date(message.date * 1000);
      const rawText = message.text;

      // Auto-create/update User
      let userId: number | null = null;
      let groupId: number | null = null;

      if (senderId) {
        const user = await createOrUpdateUser(BigInt(senderId), {
          username: senderUsername,
          firstName: message.from?.first_name,
          lastName: message.from?.last_name,
        });
        userId = user.id;
      }

      // For groups: Create group record
      // Groups are user-specific, so we create them when a user interacts
      const isGroup = message.chat.type === 'group' || message.chat.type === 'supergroup';
      
      if (isGroup && senderId) {
        try {
          // Try to find or create group for this user
          const chatTitle = (message.chat as any).title;
          const group = await createOrUpdateGroup(BigInt(chatId), BigInt(senderId), {
            name: chatTitle || undefined,
            type: 'source', // Default to source, can be changed via command
            chatType: message.chat.type,
          });
          groupId = group.id;
        } catch (error) {
          // If group creation fails (e.g., user doesn't exist yet), just log and continue
          logger.debug(`Could not create group for chat ${chatId}:`, error);
        }
      }

      // Store in DB
      const rawMessage = await createRawMessage({
        chatId: BigInt(chatId),
        messageId,
        senderId: senderId ? BigInt(senderId) : null,
        senderUsername,
        sentAt,
        rawText,
        isSignal: false, // Updated later by signal detector
        ...(groupId ? { group: { connect: { id: groupId } } } : {}),
        ...(userId ? { user: { connect: { id: userId } } } : {}),
      });

      logger.debug(`Ingested message ${messageId} from ${chatId}`);
      
      // Process Signal (Async to not block bot response?)
      // PRD doesn't specify latency, but better to process immediately for "real-time" feel
      await processMessage(rawMessage);
      
    } catch (error) {
      logger.error('Error ingesting message:', error);
    }
  } else if (channelPost && typeof channelPost === 'object' && 'caption' in channelPost) {
      // Handle channel post captions
    try {
      const message = channelPost as any;
      const chatId = message.chat?.id;
      const messageId = message.message_id;
      
      // Safety: Skip old messages (2 mins)
      if (Date.now() / 1000 - message.date > 120) {
          return next();
      }

      const senderId = message.from?.id || null;
      const senderUsername = message.from?.username;
      const sentAt = new Date(message.date * 1000);
      const rawText = message.caption || '';
      
      if (!chatId || !messageId) {
        return next();
      }
      
      let userId: number | null = null;
      if (message.from?.id) {
        const user = await createOrUpdateUser(BigInt(message.from.id), {
          username: senderUsername,
          firstName: message.from?.first_name,
          lastName: message.from?.last_name,
        });
        userId = user.id;
      }
      
      let groupId: number | null = null;
      
      // Try to find existing claimed channel
      const existing = await getAnyGroupByChatId(BigInt(chatId));
      if (existing) {
        groupId = existing.id;
      } else if (senderId) {
         // Only create group if we have a real sender (not just a channel post without signer)
         try {
          const group = await createOrUpdateGroup(BigInt(chatId), BigInt(senderId), {
            name: message.chat?.title || `Channel ${chatId}`,
            type: 'source',
            chatType: 'channel',
          });
          groupId = group.id;
        } catch (error) {
          logger.debug(`Could not create channel for chat ${chatId}:`, error);
        }
      } else {
         logger.debug(`Channel ${chatId} not claimed and no senderId in caption; skipping group creation.`);
      }
      
      const rawMessage = await createRawMessage({
        chatId: BigInt(chatId),
        messageId,
        senderId: message.from?.id ? BigInt(message.from.id) : null,
        senderUsername,
        sentAt,
        rawText,
        isSignal: false,
        ...(groupId ? { group: { connect: { id: groupId } } } : {}),
        ...(userId ? { user: { connect: { id: userId } } } : {}),
      });
      
      logger.debug(`Ingested channel media message ${messageId} from ${chatId}`);
      await processMessage(rawMessage);
    } catch (error) {
      logger.error('Error ingesting channel media message:', error);
    }
  } else if (ctx.message && 'caption' in ctx.message) {
      // Handle media captions
      try {
        const message = ctx.message;
        const chatId = message.chat.id;
        const messageId = message.message_id;
        
        // Safety: Skip old messages (2 mins)
        if (Date.now() / 1000 - message.date > 120) {
            return next();
        }

        const senderId = message.from?.id;
        const senderUsername = message.from?.username;
        const sentAt = new Date(message.date * 1000);
        const rawText = message.caption || '';

        // Auto-create/update User
        let userId: number | null = null;
        let groupId: number | null = null;

        if (senderId) {
          const user = await createOrUpdateUser(BigInt(senderId), {
            username: senderUsername,
            firstName: message.from?.first_name,
            lastName: message.from?.last_name,
          });
          userId = user.id;
        }

        // For groups: Create group record
        const isGroup = message.chat.type === 'group' || message.chat.type === 'supergroup';
        
        if (isGroup && senderId) {
          try {
            const chatTitle = (message.chat as any).title;
            const group = await createOrUpdateGroup(BigInt(chatId), BigInt(senderId), {
              name: chatTitle || undefined,
              type: 'source',
            });
            groupId = group.id;
          } catch (error) {
            logger.debug(`Could not create group for chat ${chatId}:`, error);
          }
        }
  
        // Store in DB
        const rawMessage = await createRawMessage({
          chatId: BigInt(chatId),
          messageId,
          senderId: senderId ? BigInt(senderId) : null,
          senderUsername,
          sentAt,
          rawText,
          isSignal: false,
          ...(groupId ? { group: { connect: { id: groupId } } } : {}),
          ...(userId ? { user: { connect: { id: userId } } } : {}),
        });
  
        logger.debug(`Ingested media message ${messageId} from ${chatId}`);
        await processMessage(rawMessage);
      } catch (error) {
        logger.error('Error ingesting media message:', error);
      }
  }

  return next();
};

