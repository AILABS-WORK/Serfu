import { Context } from 'telegraf';
import { BotContext } from '../../types/bot';
import { prisma } from '../../db';
import { logger } from '../../utils/logger';
import { getAllGroups, getGroupByChatId } from '../../db/groups';
import { subDays } from 'date-fns';
import { provider } from '../../providers';
import { getGroupStats, getUserStats, getLeaderboard, EntityStats } from '../../analytics/aggregator';
import { updateHistoricalMetrics } from '../../jobs/historicalMetrics';

import { UIHelper } from '../../utils/ui';

export const handleAnalyticsCommand = async (ctx: Context) => {
  try {
    const title = UIHelper.header('Analytics Dashboard');
    
    await ctx.reply(title, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '🏆 Leaderboards', callback_data: 'leaderboards_menu' },
            { text: '👥 My Groups', callback_data: 'analytics_groups' },
          ],
          [
             { text: '🟢 Live Signals', callback_data: 'live_signals' }, // Changed from Recent
             { text: '📜 Recent Calls', callback_data: 'analytics_recent' },
          ],
          [
             { text: '📊 Distributions', callback_data: 'distributions' },
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
  let msg = UIHelper.header(`${type === 'GROUP' ? 'Group' : 'User'} Analytics: ${stats.name}`);
  msg += UIHelper.subHeader('Overall Performance');
  msg += UIHelper.field('Signals', stats.totalSignals.toString()) + '\n';
  msg += UIHelper.field('Win Rate (>2x)', UIHelper.formatPercent(stats.winRate * 100)) + '\n';
  msg += UIHelper.field('Win Rate (>5x)', UIHelper.formatPercent(stats.winRate5x * 100)) + '\n';
  msg += UIHelper.field('Avg ATH', UIHelper.formatMultiple(stats.avgMultiple)) + '\n';
  msg += UIHelper.field('Avg Time to ATH', `${stats.avgTimeToAth.toFixed(0)} min`) + '\n';
  msg += UIHelper.field('Avg Drawdown', UIHelper.formatPercent(stats.avgDrawdown * 100)) + '\n';
  msg += UIHelper.field('Reliability Score', stats.score.toFixed(0)) + '\n';

  if (stats.bestCall) {
    msg += UIHelper.subHeader('Best Call (ATH)');
    msg += UIHelper.field('Token', `${stats.bestCall.symbol} (\`${stats.bestCall.mint}\`)`) + '\n';
    msg += UIHelper.field('Peak', UIHelper.formatMultiple(stats.bestCall.multiple)) + '\n';
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
        mint: string;
    }>();

    signals.forEach((s: any) => {
      // Since signals are ordered by detectedAt ASC, the first time we see a mint, it's the first call.
      if (!firstByMint.has(s.mint)) {
        firstByMint.set(s.mint, { 
            userId: s.userId, 
            groupId: s.groupId,
            detectedAt: s.detectedAt,
            multiple: s.metrics?.athMultiple || 0,
            symbol: s.symbol || '?',
            mint: s.mint // Add mint here
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

// ----------------------------------------------------------------------
// LIVE SIGNALS HANDLER (Aggregated + Filters + UIHelper)
// ----------------------------------------------------------------------

export const handleLiveSignals = async (ctx: BotContext) => {
  try {
    const ownerTelegramId = ctx.from?.id ? BigInt(ctx.from.id) : null;
    if (!ownerTelegramId) return ctx.reply('❌ Unable to identify user.');

    // 1. Get Workspace Scope
    const userGroups = await prisma.group.findMany({
        where: { owner: { userId: ownerTelegramId }, isActive: true },
        select: { id: true, chatId: true, type: true }
    });
    const ownedChatIds = userGroups.map(g => g.chatId);
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

    // 2. Fetch Active Signals
    const signals = await prisma.signal.findMany({
      where: {
        trackingStatus: 'ACTIVE',
        OR: [
            { chatId: { in: ownedChatIds } },
            { id: { in: forwardedSignalIds } }
        ]
      },
      orderBy: { detectedAt: 'asc' }, // Oldest first to find "Earliest Caller"
      include: {
        group: true,
        user: true,
      }
    });

    if (signals.length === 0) {
      return ctx.reply('No active signals right now.', {
          reply_markup: {
              inline_keyboard: [[{ text: '🔙 Back', callback_data: 'analytics' }]]
          }
      });
    }

    // 3. Aggregate by Mint
    const aggregated = new Map<string, {
        symbol: string;
        mint: string;
        earliestDate: Date;
        earliestCaller: string;
        mentions: number;
        pnl: number;
        currentPrice: number;
    }>();

    for (const sig of signals) {
        if (!aggregated.has(sig.mint)) {
            // First time seeing this mint (Earliest because sorted ASC)
            let currentPrice = 0;
            // Note: We might want to batch price fetches or rely on what's in DB if updated recently
            // For now, simple fetch (cached by provider ideally)
            try {
                const quote = await provider.getQuote(sig.mint);
                currentPrice = quote.price;
            } catch {}

            const entry = sig.entryPrice || 0;
            const pnl = entry > 0 && currentPrice > 0 ? ((currentPrice - entry) / entry) * 100 : 0;
            
            const caller = sig.user?.username ? `@${sig.user.username}` : (sig.group?.name || 'Unknown');

            aggregated.set(sig.mint, {
                symbol: sig.symbol || 'N/A',
                mint: sig.mint,
                earliestDate: sig.detectedAt,
                earliestCaller: caller,
                mentions: 0,
                pnl,
                currentPrice
            });
        }
        
        aggregated.get(sig.mint)!.mentions++;
    }

    // 4. Construct Message with UIHelper
    let message = UIHelper.header('Live Signals (Active)');
    
    // Convert to array and Sort by PnL desc
    const rows = Array.from(aggregated.values()).sort((a, b) => b.pnl - a.pnl).slice(0, 10);

    for (const row of rows) {
        // 🟢 ACORN | +120% | 5 mentions
        // 👤 @AlphaCaller | 5m ago
        const pnlStr = UIHelper.formatPercent(row.pnl);
        const icon = row.pnl >= 0 ? '🟢' : '🔴';
        const timeAgo = UIHelper.formatTimeAgo(row.earliestDate);
        
        message += `\n${icon} *${row.symbol}* | \`${pnlStr}\`\n`;
        message += `👤 ${row.earliestCaller} | ${row.mentions} mentions\n`;
        message += `🕒 ${timeAgo} | $${row.currentPrice.toFixed(6)}\n`;
        message += `\`${row.mint}\`\n`;
        message += `───────────────────`; // Slimmer separator for rows
    }

    // 5. Filters UI
    const filters = [
        [
            { text: '🚀 > 2x', callback_data: 'live_filter:2x' },
            { text: '🌕 > 5x', callback_data: 'live_filter:5x' },
            { text: '🟢 Gainers', callback_data: 'live_filter:gainers' }
        ],
        [
            { text: '🔄 Refresh', callback_data: 'live_signals' },
            { text: '❌ Close', callback_data: 'delete_msg' }
        ]
    ];

    await ctx.reply(message, { 
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: filters }
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

// ----------------------------------------------------------------------
// RECENT CALLS HANDLER (Timeline + Deduplication + V2 Design)
// ----------------------------------------------------------------------

export const handleRecentCalls = async (ctx: Context) => {
  try {
    const ownerTelegramId = ctx.from?.id ? BigInt(ctx.from.id) : null;
    if (!ownerTelegramId) return ctx.reply('❌ Unable to identify user.');

    // 1. Get Workspace Scope
    const userGroups = await prisma.group.findMany({
        where: { owner: { userId: ownerTelegramId }, isActive: true },
        select: { id: true, chatId: true, type: true }
    });
    const ownedChatIds = userGroups.map(g => g.chatId);
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

    // 2. Fetch Signals (Fetch more to allow for deduplication)
    const rawSignals = await prisma.signal.findMany({
      where: {
        OR: [
            { chatId: { in: ownedChatIds } },
            { id: { in: forwardedSignalIds } }
        ]
      },
      orderBy: { detectedAt: 'desc' },
      take: 40, // Fetch 40, display top 10 unique
      include: {
        group: true,
        user: true, 
        metrics: true, 
      },
    });

    if (rawSignals.length === 0) {
      return ctx.reply('No signals yet in your workspace.', {
          reply_markup: {
              inline_keyboard: [[{ text: '🔙 Back', callback_data: 'analytics' }]]
          }
      });
    }

    // 3. Deduplication Logic
    // Keep only the LATEST call from a specific Group for a specific Token.
    const seenMap = new Set<string>();
    const uniqueSignals = [];

    for (const sig of rawSignals) {
        const key = `${sig.groupId || 'unknown'}:${sig.mint}`;
        if (seenMap.has(key)) continue;
        
        seenMap.add(key);
        uniqueSignals.push(sig);
        if (uniqueSignals.length >= 10) break;
    }

    // 4. Trigger Metric Updates for displayed signals
    const loadingMsg = await ctx.reply('⏳ Syncing latest price data...');
    try {
        await updateHistoricalMetrics(uniqueSignals.map(s => s.id));
    } catch (err) {
        logger.warn('Background metric update failed:', err);
    }

    // 5. Build "Serfu Prime" Timeline
    // Re-fetch to get updated metrics? 
    // Actually updateHistoricalMetrics updates the DB. We should probably re-fetch or trust the update?
    // For speed, let's re-fetch just these 10 IDs to get the fresh 'metrics' relation.
    const signals = await prisma.signal.findMany({
        where: { id: { in: uniqueSignals.map(s => s.id) } },
        orderBy: { detectedAt: 'desc' },
        include: { group: true, user: true, metrics: true }
    });

    let message = UIHelper.header('RECENT ACTIVITY LOG', '📜');

    for (const sig of signals) {
        // Price Logic
        let currentPrice = 0;
        try {
            const quote = await provider.getQuote(sig.mint);
            currentPrice = quote.price;
        } catch {}

        const entry = sig.entryPrice || 0;
        const entryStr = UIHelper.formatCurrency(entry);
        const currStr = UIHelper.formatCurrency(currentPrice);
        
        // PnL & Multiple
        let multiple = 1.0;
        if (entry > 0 && currentPrice > 0) multiple = currentPrice / entry;
        
        const pnl = (multiple - 1) * 100;
        const pnlStr = UIHelper.formatPercent(pnl);
        const icon = UIHelper.getStatusIcon(pnl);
        
        const ath = sig.metrics?.athMultiple || multiple;
        const athStr = ath > multiple ? ath : multiple; // Show max

        // Attribution
        const time = sig.detectedAt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
        const source = sig.user?.username 
            ? `👤 @${sig.user.username}` 
            : `📢 ${sig.group?.name || 'Unknown Channel'}`;

        // Format:
        // 🕒 14:05 | 🟢 ACORN
        //    via 📢 Alpha Caller
        //    Entry: $0.0012 ➔ Now: $0.0035
        //    📈 +191% (3.5x Peak)
        
        message += `🕒 *${time}* | ${icon} *${sig.symbol || 'UNKNOWN'}*\n`;
        message += `   via ${source}\n`;
        message += `   💵 Entry: ${entryStr} ➔ Now: ${currStr}\n`;
        message += `   ${pnl >= 0 ? '📈' : '📉'} ${pnlStr} (\`${athStr.toFixed(2)}x\` Peak)\n`;
        message += UIHelper.separator('LIGHT');
    }

    await ctx.telegram.editMessageText(loadingMsg.chat.id, loadingMsg.message_id, undefined, message, { 
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
    try { await ctx.reply('Error loading recent calls.'); } catch {}
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
