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
    const since = subDays(new Date(), 7); // 7D default

    // 1. Get user workspace (Owned groups + Destination forwards)
    const userGroups = await prisma.group.findMany({
        where: { owner: { userId: ownerTelegramId }, isActive: true },
        select: { id: true, chatId: true, type: true }
    });
    const ownedChatIds = userGroups.map(g => g.chatId);
    
    // 2. Fetch signals
    // Note: Earliest Callers logic is a bit complex. It usually means:
    // "Within the entire ecosystem (or just my workspace?), who called it first?"
    // If we only look at my workspace, we filter by my groups.
    const signals = await prisma.signal.findMany({
      where: {
        detectedAt: { gte: since },
        chatId: { in: ownedChatIds },
        // IMPORTANT: Quality Filter. Only count signals that did > 2x.
        // Or had metrics at all (implies it was tracked).
        metrics: {
            athMultiple: { gte: 2.0 } 
        }
      },
      select: { id: true, mint: true, detectedAt: true, userId: true, group: true, user: true, metrics: true },
      orderBy: { detectedAt: 'asc' },
    });

    if (signals.length === 0) {
        return ctx.reply('No high-quality earliest calls (>2x) found in your workspace recently.');
    }

    // 3. Group by Mint to find the "First Caller" for each token
    const firstByMint = new Map<string, { 
        userId: number | null; 
        groupId: number | null;
        detectedAt: Date;
        multiple: number;
        symbol: string;
    }>();

    signals.forEach((s: any) => {
      // Since signals are ordered by detectedAt ASC, the first time we see a mint, it's the first call.
      if (!firstByMint.has(s.mint)) {
        firstByMint.set(s.mint, { 
            userId: s.userId, 
            groupId: s.groupId, // We need to handle if groupId isn't selected, but we included 'group' relation usually? Ah select above.
            detectedAt: s.detectedAt,
            multiple: s.metrics?.athMultiple || 0,
            symbol: s.symbol || '?'
        });
      }
    });

    // 4. Aggregation: Count how many "First Calls" each User/Channel has
    const userCounts = new Map<string, { count: number; totalMult: number; wins: number }>();

    for (const entry of firstByMint.values()) {
      let key = 'Unknown';
      let name = 'Unknown';

      if (entry.userId) {
          // Resolve User Name? We need to look it up or have it in map.
          // The signal query didn't fetch user name directly in the loop map.
          // Let's refactor to simplify.
          // Actually, we need to map back to the User/Group object.
          // We can use the 'signals' array again.
          const sig = signals.find(s => s.userId === entry.userId && s.mint === entry.mint); // This is inefficient but functional for small N
          if (sig && sig.user) {
              key = `user:${sig.userId}`;
              name = sig.user.username ? `@${sig.user.username}` : (sig.user.firstName || 'User');
          }
      } else {
          // Channel Call
           const sig = signals.find(s => !s.userId && s.mint === entry.mint); // Fallback to group
           if (sig && sig.group) {
               key = `group:${sig.group.id}`;
               name = sig.group.name || `Channel ${sig.group.chatId}`;
           }
      }

      if (key === 'Unknown') continue;

      if (!userCounts.has(key)) {
          userCounts.set(key, { count: 0, totalMult: 0, wins: 0 });
      }
      const stat = userCounts.get(key)!;
      stat.count++;
      stat.totalMult += entry.multiple;
      // We already filtered query by > 2x, so all are wins? 
      // Yes, in this context "Earliest Caller" leaderboard is for *good* calls.
    }

    // 5. Sort & Display
    const top = Array.from(userCounts.entries())
        .map(([key, stat]) => {
            // Retrieve name again? Or store it in map.
            // Let's just find one signal for this key to get the name.
            let name = 'Unknown';
            if (key.startsWith('user:')) {
                const uid = parseInt(key.split(':')[1]);
                const u = signals.find(s => s.userId === uid)?.user;
                name = u?.username ? `@${u.username}` : (u?.firstName || 'User');
            } else {
                const gid = parseInt(key.split(':')[1]);
                const g = signals.find(s => s.group?.id === gid)?.group;
                name = g?.name || 'Channel';
            }
            return { name, ...stat, avg: stat.totalMult / stat.count };
        })
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);

    let message = '🚀 *Top "First Callers" (>2x Wins)*\n_Who finds the gems first in your workspace?_\n\n';
    top.forEach((t, idx) => {
      const emoji = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `${idx + 1}.`;
      message += `${emoji} *${t.name}*\n`;
      message += `   🎯 ${t.count} First Calls | 💎 Avg ATH: ${t.avg.toFixed(1)}x\n\n`;
    });

    await ctx.reply(message, { 
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [[{ text: '🔙 Back', callback_data: 'analytics' }, { text: '❌ Close', callback_data: 'delete_msg' }]]
        }
    });

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

    // 1. Get all Groups owned by user (Sources AND Destinations)
    const userGroups = await prisma.group.findMany({
        where: { owner: { userId: ownerTelegramId }, isActive: true },
        select: { id: true, chatId: true, type: true }
    });

    const ownedGroupIds = userGroups.map(g => g.id);
    const ownedChatIds = userGroups.map(g => g.chatId);

    // 2. Find signals forwarded TO my destination groups
    // If a signal is forwarded to my group, I want to see it, regardless of source ownership
    const destinationGroupIds = userGroups.filter(g => g.type === 'destination').map(g => g.id);
    
    let forwardedSignalIds: number[] = [];
    if (destinationGroupIds.length > 0) {
        const forwarded = await prisma.forwardedSignal.findMany({
            where: { destGroupId: { in: destinationGroupIds.map(id => BigInt(id)) } },
            select: { signalId: true }
        });
        forwardedSignalIds = forwarded.map(f => f.signalId);
    }

    if (ownedChatIds.length === 0 && forwardedSignalIds.length === 0) {
        return ctx.reply('You are not monitoring any groups/channels yet.');
    }

    // 3. Fetch active signals:
    // - Either the signal is from a chat I monitor (ownedChatIds)
    // - OR the signal was forwarded to one of my groups (forwardedSignalIds)
    const signals = await prisma.signal.findMany({
      where: {
        trackingStatus: 'ACTIVE',
        OR: [
            { chatId: { in: ownedChatIds } },
            { id: { in: forwardedSignalIds } }
        ]
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

    // Use shared aggregator logic
    const { getDistributionStats } = await import('../../analytics/aggregator');
    const stats = await getDistributionStats(ownerTelegramId, '30D'); // Default to 30D for now

    if (stats.totalSignals === 0) {
        return ctx.reply('No data available for distributions yet.', {
            reply_markup: {
                inline_keyboard: [[{ text: '🔙 Back', callback_data: 'analytics' }]]
            }
        });
    }

    const total = stats.totalSignals;
    
    // Helper for Bar Chart
    const drawBar = (count: number, max: number = total, length: number = 8) => {
        if (max === 0) return '░'.repeat(length);
        const filled = Math.round((count / max) * length);
        return '█'.repeat(filled) + '░'.repeat(length - filled);
    };

    const p = (count: number) => ((count / total) * 100).toFixed(0) + '%';

    let message = '📊 *Distribution Analysis (30D)*\n\n';

    // 1. ATH Distribution
    message += '*📈 ATH Multiples*\n';
    message += `\`>10x :\` ${drawBar(stats.winRateBuckets.x10_plus)} ${stats.winRateBuckets.x10_plus} (${p(stats.winRateBuckets.x10_plus)})\n`;
    message += `\`5-10x:\` ${drawBar(stats.winRateBuckets.x5_10)} ${stats.winRateBuckets.x5_10} (${p(stats.winRateBuckets.x5_10)})\n`;
    message += `\`3-5x :\` ${drawBar(stats.winRateBuckets.x3_5)} ${stats.winRateBuckets.x3_5} (${p(stats.winRateBuckets.x3_5)})\n`;
    message += `\`2-3x :\` ${drawBar(stats.winRateBuckets.x2_3)} ${stats.winRateBuckets.x2_3} (${p(stats.winRateBuckets.x2_3)})\n`;
    message += `\`1-2x :\` ${drawBar(stats.winRateBuckets.x1_2)} ${stats.winRateBuckets.x1_2} (${p(stats.winRateBuckets.x1_2)})\n`;
    message += `\`<1x  :\` ${drawBar(stats.winRateBuckets.loss)} ${stats.winRateBuckets.loss} (${p(stats.winRateBuckets.loss)})\n\n`;

    // 2. MC Bucket Analysis
    message += '*💰 Market Cap Performance*\n_Win Rate (>2x) | Avg ATH_\n\n';
    
    for (const b of stats.mcBuckets) {
        if (b.count === 0) continue;
        const winRate = (b.wins / b.count) * 100;
        // Determine indicator based on WR
        let icon = '⚪';
        if (winRate >= 50) icon = '🟢';
        else if (winRate >= 30) icon = '🟡';
        else icon = '🔴';

        // Format label to align
        const label = b.label.padEnd(9, ' ');
        
        message += `\`${label}\` : ${icon} ${winRate.toFixed(0)}% WR | 💎 ${b.avgMult.toFixed(1)}x\n`;
    }

    await ctx.reply(message, { 
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '🔙 Back', callback_data: 'analytics' }, { text: '❌ Close', callback_data: 'delete_msg' }]
            ]
        }
    });

  } catch (error) {
    logger.error('Error loading distributions:', error);
    ctx.reply('Error loading distributions.');
  }
};

export const handleRecentCalls = async (ctx: Context) => {
  try {
    const ownerTelegramId = ctx.from?.id ? BigInt(ctx.from.id) : null;
    if (!ownerTelegramId) return ctx.reply('❌ Unable to identify user.');

    // 1. Get all Groups owned by user (Sources AND Destinations)
    const userGroups = await prisma.group.findMany({
        where: { owner: { userId: ownerTelegramId }, isActive: true },
        select: { id: true, chatId: true, type: true }
    });

    const ownedChatIds = userGroups.map(g => g.chatId);

    // 2. Find signals forwarded TO my destination groups
    const destinationGroupIds = userGroups.filter(g => g.type === 'destination').map(g => g.id);
    
    let forwardedSignalIds: number[] = [];
    if (destinationGroupIds.length > 0) {
        const forwarded = await prisma.forwardedSignal.findMany({
            where: { destGroupId: { in: destinationGroupIds.map(id => BigInt(id)) } },
            select: { signalId: true }
        });
        forwardedSignalIds = forwarded.map(f => f.signalId);
    }

    if (ownedChatIds.length === 0 && forwardedSignalIds.length === 0) {
        return ctx.reply('You are not monitoring any groups/channels yet.');
    }

    // 3. Fetch top recent signals matching Chat IDs OR Forwarded IDs
    const recentSignals = await prisma.signal.findMany({
      where: {
        OR: [
            { chatId: { in: ownedChatIds } },
            { id: { in: forwardedSignalIds } }
        ]
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

    // 4. Notify user we are loading fresh data
    const loadingMsg = await ctx.reply('⏳ Calculating latest metrics (ATH/DD)... please wait.');

    // 5. Force synchronous update for these specific signals
    try {
        const signalIds = recentSignals.map(s => s.id);
        await updateHistoricalMetrics(signalIds);
    } catch (err) {
        logger.error('Targeted update failed during recent calls view:', err);
    }

    // 6. Fetch full data (now with updated metrics)
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

    // 7. Update the loading message with the result and ADD buttons
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
    // Try to reply with error if edit fails, or just log
    try {
        await ctx.reply('Error loading recent calls. Please try again.');
    } catch(e) {
        // ignore
    }
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
