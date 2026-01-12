import { Context } from 'telegraf';
import { prisma } from '../../db';
import { logger } from '../../utils/logger';
import { getAllGroups, getGroupByChatId } from '../../db/groups';
import { subDays } from 'date-fns';
import { provider } from '../../providers';
import { getGroupStats, getUserStats, getLeaderboard, EntityStats } from '../../analytics/aggregator';
import { updateHistoricalMetrics } from '../../jobs/historicalMetrics';

export const handleAnalyticsCommand = async (ctx: Context) => {
  try {
    // Trigger background update if requested or maybe just always async update?
    // Let's not block the UI but start an update if it hasn't run recently.
    // For now, we rely on the job.
    
    await ctx.reply('📊 *Analytics Dashboard*', {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '🏆 Leaderboards', callback_data: 'leaderboards_menu' },
            { text: '👥 My Groups', callback_data: 'analytics_groups' },
          ],
          [
             { text: '📜 Recent Calls', callback_data: 'analytics_recent' },
             { text: '👤 User Stats', callback_data: 'analytics_users_input' },
          ],
          [
            { text: '🚀 Earliest Callers', callback_data: 'analytics_earliest' },
            { text: '🔁 Cross-Group Confirms', callback_data: 'analytics_confirms' },
          ],
          [
            { text: '🔄 Refresh Metrics', callback_data: 'analytics_refresh' },
          ]
        ],
      },
    });
  } catch (error) {
    logger.error('Error in /analytics command:', error);
    ctx.reply('Error loading analytics.');
  }
};

const formatEntityStats = (stats: EntityStats, type: 'GROUP' | 'USER'): string => {
  let msg = `📊 *${type === 'GROUP' ? 'Group' : 'User'} Analytics: ${stats.name}*\n\n`;
  msg += `*Overall Performance*\n`;
  msg += `Signals: \`${stats.totalSignals}\`\n`;
  msg += `Win Rate (>2x): \`${(stats.winRate * 100).toFixed(1)}%\`\n`;
  msg += `Win Rate (>5x): \`${(stats.winRate5x * 100).toFixed(1)}%\`\n`;
  msg += `Avg ATH: \`${stats.avgMultiple.toFixed(2)}x\`\n`;
  msg += `Avg Time to ATH: \`${stats.avgTimeToAth.toFixed(0)} min\`\n`;
  msg += `Avg Drawdown: \`${(stats.avgDrawdown * 100).toFixed(1)}%\`\n`;
  msg += `Reliability Score: \`${stats.score.toFixed(0)}\`\n\n`;

  if (stats.bestCall) {
    msg += `*Best Call (ATH)*\n`;
    msg += `Token: ${stats.bestCall.symbol} (\`${stats.bestCall.mint}\`)\n`;
    msg += `Peak: \`${stats.bestCall.multiple.toFixed(2)}x\`\n`;
  }

  return msg;
};

// ... existing handler code ...

export const handleGroupStatsCommand = async (ctx: Context, groupIdStr?: string, window: '7D' | '30D' | 'ALL' = 'ALL') => {
  try {
    const userId = ctx.from?.id ? BigInt(ctx.from.id) : null;
    if (!userId) return ctx.reply('❌ Unable to identify user.');

    let targetGroupId: number | null = null;
    if (groupIdStr) {
      targetGroupId = parseInt(groupIdStr);
    } else if (ctx.chat?.type !== 'private') {
      const group = await prisma.group.findFirst({ where: { chatId: BigInt(ctx.chat!.id) } });
      if (group) targetGroupId = group.id;
    }

    if (!targetGroupId) {
      return ctx.reply('Please use this command in a group or select one from the menu.');
    }

    const stats = await getGroupStats(targetGroupId, window);
    if (!stats) {
      // If callback, answer it
      if (ctx.callbackQuery) await ctx.answerCbQuery('Group not found or no data available.');
      else await ctx.reply('Group not found or no data available.');
      return;
    }

    const message = formatEntityStats(stats, 'GROUP') + `\n📅 Timeframe: *${window}*`;
    
    const keyboard = {
        inline_keyboard: [
          [
            { text: window === '7D' ? '✅ 7D' : '7D', callback_data: `group_stats_window:${targetGroupId}:7D` },
            { text: window === '30D' ? '✅ 30D' : '30D', callback_data: `group_stats_window:${targetGroupId}:30D` },
            { text: window === 'ALL' ? '✅ ALL' : 'ALL', callback_data: `group_stats_window:${targetGroupId}:ALL` },
          ],
          [
            { text: '🔙 Back', callback_data: 'analytics_groups' },
          ],
        ],
    };

    if (ctx.callbackQuery && ctx.callbackQuery.message) {
        await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: keyboard });
    } else {
        await ctx.reply(message, { parse_mode: 'Markdown', reply_markup: keyboard });
    }

  } catch (error) {
    logger.error('Error in /groupstats command:', error);
    ctx.reply('Error fetching group stats.');
  }
};

export const handleUserStatsCommand = async (ctx: Context, userIdStr?: string, window: '7D' | '30D' | 'ALL' = 'ALL') => {
  try {
    if (!userIdStr) {
        const user = await prisma.user.findUnique({ where: { userId: BigInt(ctx.from!.id) }});
        if (user) userIdStr = user.id.toString();
        else return ctx.reply("You are not registered in the system yet.");
    }
    
    const targetUserId = parseInt(userIdStr || '0');
    const stats = await getUserStats(targetUserId, window);

    if (!stats) {
      if (ctx.callbackQuery) await ctx.answerCbQuery('User not found or no data available.');
      else await ctx.reply('User not found or no data available.');
      return;
    }

    const message = formatEntityStats(stats, 'USER') + `\n📅 Timeframe: *${window}*`;

    const keyboard = {
        inline_keyboard: [
           [
            { text: window === '7D' ? '✅ 7D' : '7D', callback_data: `user_stats_window:${targetUserId}:7D` },
            { text: window === '30D' ? '✅ 30D' : '30D', callback_data: `user_stats_window:${targetUserId}:30D` },
            { text: window === 'ALL' ? '✅ ALL' : 'ALL', callback_data: `user_stats_window:${targetUserId}:ALL` },
          ],
          [
            { text: '🔙 Back', callback_data: 'analytics_users_input' }, // Go back to user list
          ],
        ],
    };

    if (ctx.callbackQuery && ctx.callbackQuery.message) {
        await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: keyboard });
    } else {
        await ctx.reply(message, { parse_mode: 'Markdown', reply_markup: keyboard });
    }
  } catch (error) {
    logger.error('Error in /userstats command:', error);
    ctx.reply('Error fetching user stats.');
  }
};

export const handleGroupLeaderboardCommand = async (ctx: Context, window: '7D' | '30D' | 'ALL' = '30D') => {
  try {
    const statsList = await getLeaderboard('GROUP', window, 'SCORE', 10);
    
    if (statsList.length === 0) {
        return ctx.reply(`No group data available for ${window}.`);
    }

    let message = `🏆 *Top Groups (${window})*\n_Sorted by Reliability Score_\n\n`;
    
    // Generate Buttons
    const entityButtons: any[] = [];
    
    statsList.forEach((s, i) => {
        const rank = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i+1}.`;
        message += `${rank} *${s.name}*\n`;
        message += `   💎 ${s.avgMultiple.toFixed(2)}x Avg | 🎯 ${(s.winRate*100).toFixed(0)}% WR | Score: ${s.score.toFixed(0)}\n\n`;
        
        // Add button for top 5
        if (i < 5) {
            entityButtons.push([{ text: `${rank} ${s.name} Stats`, callback_data: `group_stats_view:${s.id}` }]);
        }
    });

    const keyboard = {
        inline_keyboard: [
            ...entityButtons,
            [
                { text: '7D', callback_data: 'leaderboard_groups:7D' },
                { text: '30D', callback_data: 'leaderboard_groups:30D' },
                { text: 'ALL', callback_data: 'leaderboard_groups:ALL' },
            ],
            [{ text: '👤 User Leaderboard', callback_data: 'leaderboard_users:30D' }],
            [{ text: '🔙 Analytics', callback_data: 'analytics' }],
        ]
    };

    if (ctx.callbackQuery && ctx.callbackQuery.message) {
         await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: keyboard });
    } else {
         await ctx.reply(message, { parse_mode: 'Markdown', reply_markup: keyboard });
    }

  } catch (error) {
    logger.error('Error in group leaderboard:', error);
    ctx.reply('Error loading leaderboard.');
  }
};

export const handleUserLeaderboardCommand = async (ctx: Context, window: '7D' | '30D' | 'ALL' = '30D') => {
  try {
    const statsList = await getLeaderboard('USER', window, 'SCORE', 10);
    
    if (statsList.length === 0) {
        return ctx.reply(`No user data available for ${window}.`);
    }

    let message = `🏆 *Top Callers (${window})*\n_Sorted by Reliability Score_\n\n`;
    const entityButtons: any[] = [];

    statsList.forEach((s, i) => {
        const rank = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i+1}.`;
        message += `${rank} *${s.name}*\n`;
        message += `   💎 ${s.avgMultiple.toFixed(2)}x Avg | 🎯 ${(s.winRate*100).toFixed(0)}% WR | Score: ${s.score.toFixed(0)}\n\n`;
        
        if (i < 5) {
             entityButtons.push([{ text: `${rank} ${s.name} Stats`, callback_data: `user_stats_view:${s.id}` }]);
        }
    });

    const keyboard = {
        inline_keyboard: [
            ...entityButtons,
            [
                { text: '7D', callback_data: 'leaderboard_users:7D' },
                { text: '30D', callback_data: 'leaderboard_users:30D' },
                { text: 'ALL', callback_data: 'leaderboard_users:ALL' },
            ],
            [{ text: '👥 Group Leaderboard', callback_data: 'leaderboard_groups:30D' }],
            [{ text: '💎 Top Signals', callback_data: 'leaderboard_signals:30D' }],
            [{ text: '🔙 Analytics', callback_data: 'analytics' }],
        ]
    };

    if (ctx.callbackQuery && ctx.callbackQuery.message) {
        await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: keyboard });
   } else {
        await ctx.reply(message, { parse_mode: 'Markdown', reply_markup: keyboard });
   }
  } catch (error) {
    logger.error('Error in user leaderboard:', error);
    ctx.reply('Error loading leaderboard.');
  }
};

export const handleSignalLeaderboardCommand = async (ctx: Context, window: '7D' | '30D' | 'ALL' = '30D') => {
  try {
    const { getSignalLeaderboard } = await import('../../analytics/aggregator');
    const signals = await getSignalLeaderboard(window, 10);
    
    if (signals.length === 0) {
        return ctx.reply(`No signal data available for ${window}.`);
    }

    let message = `💎 *Top Signals (${window})*\n_Sorted by ATH Multiple_\n\n`;
    const signalButtons: any[] = [];

    signals.forEach((s, i) => {
        const rank = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i+1}.`;
        message += `${rank} *${s.symbol}* (${s.athMultiple.toFixed(2)}x)\n`;
        message += `   Caller: ${s.sourceName} | 📅 ${s.detectedAt.toLocaleDateString()}\n`;
        message += `   \`${s.mint}\`\n\n`;

        if (i < 5) {
            signalButtons.push([{ text: `${rank} ${s.symbol} Stats`, callback_data: `stats:${s.id}` }]);
        }
    });

    const keyboard = {
        inline_keyboard: [
            ...signalButtons,
            [
                { text: '7D', callback_data: 'leaderboard_signals:7D' },
                { text: '30D', callback_data: 'leaderboard_signals:30D' },
                { text: 'ALL', callback_data: 'leaderboard_signals:ALL' },
            ],
            [{ text: '🔙 Leaderboards', callback_data: 'leaderboards_menu' }],
        ]
    };

    if (ctx.callbackQuery && ctx.callbackQuery.message) {
         await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: keyboard });
    } else {
         await ctx.reply(message, { parse_mode: 'Markdown', reply_markup: keyboard });
    }
  } catch (error) {
    logger.error('Error in signal leaderboard:', error);
    ctx.reply('Error loading leaderboard.');
  }
};

export const handleEarliestCallers = async (ctx: Context) => {
  try {
    const ownerTelegramId = ctx.from?.id ? BigInt(ctx.from.id) : null;
    if (!ownerTelegramId) return ctx.reply('❌ Unable to identify user.');
    const since = subDays(new Date(), 7);

    // Signals in owner workspace last 7d
    const signals = await prisma.signal.findMany({
      where: {
        detectedAt: { gte: since },
        group: { owner: { userId: ownerTelegramId } },
      },
      select: { id: true, mint: true, detectedAt: true, userId: true },
      orderBy: { detectedAt: 'asc' },
    });

    const firstByMint = new Map<string, { userId: number | null; detectedAt: Date }>();
    signals.forEach((s: any) => {
      if (!firstByMint.has(s.mint)) {
        firstByMint.set(s.mint, { userId: s.userId, detectedAt: s.detectedAt });
      }
    });

    const counts = new Map<number, number>();
    for (const entry of firstByMint.values()) {
      if (entry.userId) {
        counts.set(entry.userId, (counts.get(entry.userId) || 0) + 1);
      }
    }

    if (counts.size === 0) {
      return ctx.reply('No earliest callers yet in the last 7 days.');
    }

    const top = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10);
    const users = await prisma.user.findMany({
      where: { id: { in: top.map((t) => t[0]) } },
    });
    const userMap = new Map<number, any>(users.map((u: any) => [u.id, u]));

    let message = '🚀 *Earliest Callers (7d, your workspace)*\n\n';
    top.forEach(([uid, cnt], idx) => {
      const u = userMap.get(uid);
      // Use "as any" to access dynamic properties if User type is incomplete in context
      const name = (u as any)?.username || (u as any)?.firstName || (u as any)?.userId || uid;
      const emoji = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `${idx + 1}.`;
      message += `${emoji} @${name} — ${cnt} first calls\n`;
    });

    await ctx.reply(message, { parse_mode: 'Markdown' });
  } catch (error) {
    logger.error('Error in earliest callers:', error);
    ctx.reply('Error computing earliest callers.');
  }
};

export const handleCrossGroupConfirms = async (ctx: Context) => {
  try {
    const ownerTelegramId = ctx.from?.id ? BigInt(ctx.from.id) : null;
    if (!ownerTelegramId) return ctx.reply('❌ Unable to identify user.');
    const since = subDays(new Date(), 7);

    // Signals with group owner filter
    const signals = await prisma.signal.findMany({
      where: {
        detectedAt: { gte: since },
        group: { owner: { userId: ownerTelegramId } },
      },
      select: { mint: true, groupId: true },
    });

    const byMint = new Map<string, Set<number>>();
    signals.forEach((s: any) => {
      if (!byMint.has(s.mint)) byMint.set(s.mint, new Set());
      byMint.get(s.mint)!.add(s.groupId || -1);
    });

    const multiGroup = Array.from(byMint.entries())
      .map(([mint, groups]) => ({ mint, groups: Array.from(groups) }))
      .filter((m) => m.groups.length > 1)
      .slice(0, 20);

    if (multiGroup.length === 0) {
      return ctx.reply('No cross-group confirmations yet in the last 7 days.');
    }

    let message = '🔁 *Cross-Group Confirmations (7d, your workspace)*\n\n';
    multiGroup.slice(0, 10).forEach((m, idx) => {
      const emoji = idx === 0 ? '🔥' : `${idx + 1}.`;
      message += `${emoji} \`${m.mint}\` — ${m.groups.length} groups\n`;
    });

    await ctx.reply(message, { parse_mode: 'Markdown' });
  } catch (error) {
    logger.error('Error in cross-group confirmations:', error);
    ctx.reply('Error computing cross-group confirmations.');
  }
};

export const handleLiveSignals = async (ctx: Context) => {
  try {
    const ownerTelegramId = ctx.from?.id ? BigInt(ctx.from.id) : null;
    if (!ownerTelegramId) return ctx.reply('❌ Unable to identify user.');

    // 1. Get all Chat IDs monitored by the user (Sources)
    const userGroups = await prisma.group.findMany({
        where: { owner: { userId: ownerTelegramId }, isActive: true },
        select: { chatId: true }
    });

    const monitoredChatIds = userGroups.map(g => g.chatId);

    if (monitoredChatIds.length === 0) {
        return ctx.reply('You are not monitoring any groups/channels yet.');
    }

    // 2. Fetch active signals matching those Chat IDs
    const signals = await prisma.signal.findMany({
      where: {
        trackingStatus: 'ACTIVE',
        chatId: { in: monitoredChatIds }, // Match by Chat ID, not just specific Group ID linkage
      },
      orderBy: { detectedAt: 'desc' },
      include: {
        group: true,
        user: true,
      },
      take: 10,
    });

    if (signals.length === 0) {
      return ctx.reply('No active signals right now. Check back later!', {
          reply_markup: {
              inline_keyboard: [[{ text: '🔙 Back', callback_data: 'analytics' }]]
          }
      });
    }

    let message = '🟢 *Live Signals (Active)*\n\n';
    
    for (const sig of signals) {
      // Get current price
      let currentPrice = 0;
      try {
        const quote = await provider.getQuote(sig.mint);
        currentPrice = quote.price;
      } catch (e) {
        // ignore
      }

      const entry = sig.entryPrice || 0;
      const pnl = entry > 0 && currentPrice > 0 
        ? ((currentPrice - entry) / entry) * 100 
        : 0;
      const pnlStr = pnl >= 0 ? `+${pnl.toFixed(1)}%` : `${pnl.toFixed(1)}%`;
      const timeAgo = Math.floor((Date.now() - sig.detectedAt.getTime()) / (1000 * 60)); // minutes

      // Attribution
      const sourceName = sig.user?.username || sig.group?.name || 'Unknown Source';

      message += `• *${sig.symbol || 'N/A'}* (${pnlStr})\n`;
      message += `  $${currentPrice.toFixed(6)} | ${timeAgo}m ago\n`;
      message += `  Via: ${sourceName} | \`${sig.mint}\`\n\n`;
    }

    await ctx.reply(message, { 
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '🔄 Refresh', callback_data: 'live_signals' }],
                [{ text: '🔙 Back', callback_data: 'analytics' }, { text: '❌ Close', callback_data: 'delete_msg' }]
            ]
        }
    });

  } catch (error) {
    logger.error('Error loading live signals:', error);
    ctx.reply('Error loading live signals.');
  }
};

export const handleDistributions = async (ctx: Context) => {
  try {
    const ownerTelegramId = ctx.from?.id ? BigInt(ctx.from.id) : null;
    if (!ownerTelegramId) return ctx.reply('❌ Unable to identify user.');

    const since = subDays(new Date(), 30); // 30D default

    const signals = await prisma.signal.findMany({
      where: {
        detectedAt: { gte: since },
        group: { owner: { userId: ownerTelegramId } },
        metrics: { isNot: null }
      },
      include: { metrics: true }
    });

    if (signals.length === 0) {
        return ctx.reply('No data available for distributions yet.');
    }

    const buckets = {
        loss: 0,
        x1_2: 0,
        x2_3: 0,
        x3_5: 0,
        x5_10: 0,
        x10_plus: 0
    };

    signals.forEach(s => {
        const mult = s.metrics?.athMultiple || 0;
        if (mult < 1) buckets.loss++;
        else if (mult < 2) buckets.x1_2++;
        else if (mult < 3) buckets.x2_3++;
        else if (mult < 5) buckets.x3_5++;
        else if (mult < 10) buckets.x5_10++;
        else buckets.x10_plus++;
    });

    const total = signals.length;
    const p = (count: number) => ((count / total) * 100).toFixed(1) + '%';
    const bar = (count: number) => '█'.repeat(Math.round((count / total) * 10));

    let message = '📊 *Win Rate Distribution (30D)*\n\n';
    message += `🔴 <1x: ${p(buckets.loss)} ${bar(buckets.loss)}\n`;
    message += `⚪ 1-2x: ${p(buckets.x1_2)} ${bar(buckets.x1_2)}\n`;
    message += `🟢 2-3x: ${p(buckets.x2_3)} ${bar(buckets.x2_3)}\n`;
    message += `🟢 3-5x: ${p(buckets.x3_5)} ${bar(buckets.x3_5)}\n`;
    message += `🚀 5-10x: ${p(buckets.x5_10)} ${bar(buckets.x5_10)}\n`;
    message += `🌕 >10x: ${p(buckets.x10_plus)} ${bar(buckets.x10_plus)}\n`;

    await ctx.reply(message, { parse_mode: 'Markdown' });

  } catch (error) {
    logger.error('Error loading distributions:', error);
    ctx.reply('Error loading distributions.');
  }
};

export const handleRecentCalls = async (ctx: Context) => {
  try {
    const ownerTelegramId = ctx.from?.id ? BigInt(ctx.from.id) : null;
    if (!ownerTelegramId) return ctx.reply('❌ Unable to identify user.');

    // 1. Get monitored Chat IDs
    const userGroups = await prisma.group.findMany({
        where: { owner: { userId: ownerTelegramId }, isActive: true },
        select: { chatId: true }
    });
    const monitoredChatIds = userGroups.map(g => g.chatId);

    if (monitoredChatIds.length === 0) {
        return ctx.reply('You are not monitoring any groups/channels yet.');
    }

    // 2. Fetch top recent signals matching Chat IDs
    const recentSignals = await prisma.signal.findMany({
      where: {
        chatId: { in: monitoredChatIds },
      },
      orderBy: { detectedAt: 'desc' },
      take: 6,
      select: { id: true, mint: true }
    });

    if (recentSignals.length === 0) {
      return ctx.reply('No signals yet in your workspace.', {
          reply_markup: {
              inline_keyboard: [[{ text: '🔙 Back', callback_data: 'analytics' }]]
          }
      });
    }

    // 3. Notify user we are loading fresh data
    const loadingMsg = await ctx.reply('⏳ Calculating latest metrics (ATH/DD)... please wait.');

    // 4. Force synchronous update for these specific signals
    try {
        const signalIds = recentSignals.map(s => s.id);
        await updateHistoricalMetrics(signalIds);
    } catch (err) {
        logger.error('Targeted update failed during recent calls view:', err);
    }

    // 5. Fetch full data (now with updated metrics)
    const signals = await prisma.signal.findMany({
      where: {
        id: { in: recentSignals.map(s => s.id) }
      },
      orderBy: { detectedAt: 'desc' },
      include: {
        group: true,
        user: true, 
        metrics: true, 
      },
    });

    let message = '📜 *Recent Calls*\n\n';
    for (const sig of signals) {
      let currentPrice: number | null = null;
      try {
        const quote = await provider.getQuote(sig.mint);
        currentPrice = quote.price;
      } catch (err) {
        logger.debug(`Recent calls quote failed for ${sig.mint}:`, err);
      }

      const entryPrice = sig.entryPrice || null;
      const multiple = currentPrice && entryPrice ? currentPrice / entryPrice : null;
      
      let athMult = sig.metrics?.athMultiple || 1.0;
      if (multiple && athMult < multiple) {
          athMult = multiple;
      }
      if (!sig.metrics && (!multiple || multiple < 1)) {
          athMult = 1.0;
      }
      
      const drawdown = sig.metrics?.maxDrawdown ?? 0;

      const callerName = sig.user?.username || sig.user?.firstName;
      // If user is null, fallback to group name.
      const displayCaller = callerName ? `@${callerName}` : (sig.group?.name || 'Unknown Channel');

      message += `• *${sig.name || sig.symbol || sig.mint}* (${sig.symbol || 'N/A'})\n`;
      message += `  Group: ${sig.group?.name || sig.group?.chatId || 'N/A'}\n`;
      message += `  Caller: ${displayCaller}\n`;
      message += `  Entry: $${entryPrice ? entryPrice.toFixed(6) : 'Pending'} | Cur: ${multiple ? `${multiple.toFixed(2)}x` : 'N/A'}\n`;
      message += `  ATH: \`${athMult.toFixed(2)}x\` | DD: \`${(drawdown * 100).toFixed(0)}%\`\n`;
      message += `  Mint: \`${sig.mint}\`\n\n`;
    }

    // 6. Update the loading message with the result and ADD buttons
    await ctx.telegram.editMessageText(loadingMsg.chat.id, loadingMsg.message_id, undefined, message.trim(), { 
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '🔄 Refresh', callback_data: 'analytics_recent' }],
                [{ text: '🔙 Back', callback_data: 'analytics' }, { text: '❌ Close', callback_data: 'delete_msg' }]
            ]
        }
    });
    
  } catch (error) {
    logger.error('Error loading recent calls:', error);
    ctx.reply('Error loading recent calls.');
  }
};

export const handleRefreshMetrics = async (ctx: Context) => {
    try {
        await ctx.reply('🔄 Refreshing historical metrics... This may take a moment.');
        await updateHistoricalMetrics();
        await ctx.reply('✅ Metrics refreshed. Check Leaderboards or Stats again.');
    } catch (error) {
        logger.error('Manual refresh failed:', error);
        ctx.reply('❌ Refresh failed.');
    }
};
