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
  let msg = UIHelper.header(`${type === 'GROUP' ? 'Group' : 'User'} Analytics: ${stats.name}`, '📊');
  
  msg += UIHelper.subHeader('PERFORMANCE MATRIX', '🔹');
  msg += `   🏆 *Score:* \`${stats.score.toFixed(0)}/100\`\n`;
  msg += `   📡 *Signals:* ${stats.totalSignals}\n`;
  msg += `   ✅ *Win Rate:* ${UIHelper.formatPercent(stats.winRate * 100)} ${UIHelper.progressBar(stats.winRate * 100, 100, 6)}\n`;
  msg += `   💎 *Moon Rate:* ${UIHelper.formatPercent(stats.winRate5x * 100)} (>5x)\n`;
  msg += `   📈 *Avg ROI:* ${UIHelper.formatMultiple(stats.avgMultiple)}\n`;

  msg += UIHelper.subHeader('RISK PROFILE', '🔹');
  msg += `   🎲 *Consistency:* ${stats.consistency.toFixed(2)} (StdDev)\n`;
  msg += `   📉 *Avg Drawdown:* ${UIHelper.formatPercent(stats.avgDrawdown * 100)}\n`;
  msg += `   💀 *Rug Rate:* ${UIHelper.formatPercent(stats.rugRate * 100)}\n`;

  msg += UIHelper.subHeader('BEHAVIORAL ANALYSIS', '🔹');
  msg += `   💰 *Avg MCap:* $${(stats.mcapAvg / 1000).toFixed(1)}k\n`;
  msg += `   ⚡ *Sniper Score:* ${stats.sniperScore.toFixed(0)}%\n`;
  msg += `   🚀 *Speed Score:* ${stats.speedScore.toFixed(0)}/100\n`;
  msg += `   💎 *Diamond Hands:* ${(stats.diamondHands * 100).toFixed(0)}%\n`;
  msg += `   📄 *Paper Hands:* ${(stats.paperHands * 100).toFixed(0)}%\n`;
  msg += `   ⏳ *Avg Lifespan:* ${stats.avgLifespan.toFixed(1)}h\n`;
  msg += `   🔥 *Streak:* ${stats.consecutiveWins} wins\n`;
  msg += `   📊 *Volatility Index:* ${stats.volatilityIndex.toFixed(2)}\n`;
  msg += `   🏆 *Reliability Tier:* ${stats.reliabilityTier}\n`;
  msg += `   🎯 *Favorite Sector:* ${stats.topSector}\n`;

  if (stats.bestCall) {
    msg += UIHelper.subHeader('CROWN JEWEL (Best Call)', '🔹');
    msg += `   💎 *${stats.bestCall.symbol}* (\`${stats.bestCall.mint}\`)\n`;
    msg += `   🚀 *${stats.bestCall.multiple.toFixed(2)}x* Peak | 📅 ${stats.bestCall.detectedAt ? stats.bestCall.detectedAt.toLocaleDateString() : 'N/A'}\n`;
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
             { text: '🪄 Strategy', callback_data: `strategy_view:GROUP:${targetGroupId}` },
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
            { text: '🪄 Strategy', callback_data: `strategy_view:USER:${targetUserId}` },
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

export const handleCrossGroupConfirms = async (ctx: Context, view: string = 'lag') => {
  try {
    const ownerTelegramId = ctx.from?.id ? BigInt(ctx.from.id) : null;
    if (!ownerTelegramId) return ctx.reply('❌ Unable to identify user.');
    
    // 1. Get Workspace Scope
    const userGroups = await prisma.group.findMany({
        where: { owner: { userId: ownerTelegramId }, isActive: true },
        select: { id: true, chatId: true, type: true, name: true }
    });
    
    if (userGroups.length < 2) {
        return ctx.reply('You need to monitor at least 2 groups to see cross-group correlations.');
    }

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

    // 2. Fetch Signals (Last 7 Days)
    const since = subDays(new Date(), 7);
    const signals = await prisma.signal.findMany({
      where: {
        detectedAt: { gte: since },
        OR: [
            { chatId: { in: ownedChatIds } },
            { id: { in: forwardedSignalIds } }
        ]
      },
      select: { mint: true, groupId: true, detectedAt: true, group: { select: { id: true, name: true } } },
      orderBy: { detectedAt: 'asc' }
    });

    if (signals.length === 0) {
        return ctx.reply('No signals found in the last 7 days to analyze.');
    }

    // 3. Group by Mint
    const byMint = new Map<string, Array<{ groupId: number; groupName: string; time: number }>>();
    
    for (const s of signals) {
        if (!s.groupId) continue; // Skip channel signals without group? Or map them differently?
        // Note: Channel signals might have groupId if mapped correctly in ingestion.
        // If s.group is null, we might skip or handle as "Unknown".
        if (!byMint.has(s.mint)) byMint.set(s.mint, []);
        
        // Avoid duplicates from same group for same mint?
        const list = byMint.get(s.mint)!;
        if (!list.find(x => x.groupId === s.groupId)) {
            list.push({ 
                groupId: s.groupId, 
                groupName: s.group?.name || `Group ${s.groupId}`, 
                time: s.detectedAt.getTime() 
            });
        }
    }

    // 4. Analyze Pairs - Enhanced with all metrics
    // Map: "id1-id2" -> { count, lagSum, id1LeadCount, confluenceWins, uniqueG1, uniqueG2 }
    const pairStats = new Map<string, {
        g1Name: string;
        g2Name: string;
        count: number;
        lagSum: number; // in milliseconds
        g1LeadCount: number;
        confluenceWins: number; // Both called same token and it won (>2x)
        uniqueG1: Set<string>; // Unique mints for G1
        uniqueG2: Set<string>; // Unique mints for G2
    }>();

    const groupIds = userGroups.map(g => g.id);
    const groupMap = new Map(userGroups.map(g => [g.id, g.name || `Group ${g.chatId}`]));
    const sevenDaysAgo = subDays(new Date(), 7);

    // Track unique signals per group
    const groupUniqueMints = new Map<number, Set<string>>();
    for (const gid of groupIds) {
        groupUniqueMints.set(gid, new Set());
    }

    // Fetch signals with metrics for win detection
    const signalsWithMetrics = await prisma.signal.findMany({
        where: {
            groupId: { in: groupIds },
            detectedAt: { gte: sevenDaysAgo },
            metrics: { isNot: null }
        },
        include: { metrics: true, group: true }
    });

    const mintWinMap = new Map<string, boolean>();
    for (const s of signalsWithMetrics) {
        groupUniqueMints.get(s.groupId!)?.add(s.mint);
        const isWin = s.metrics?.athMultiple && s.metrics.athMultiple > 2;
        if (isWin) mintWinMap.set(s.mint, true);
    }

    for (const [mint, calls] of byMint.entries()) {
        if (calls.length < 2) continue;
        
        // Sort by time to see who was first for THIS token
        calls.sort((a, b) => a.time - b.time);
        
        // Check if this mint was a winner
        const isWin = mintWinMap.get(mint) || false;

        // Generate pairs
        for (let i = 0; i < calls.length; i++) {
            for (let j = i + 1; j < calls.length; j++) {
                const c1 = calls[i];
                const c2 = calls[j];
                
                // Canonical Key: smallest ID first
                const [p1, p2] = c1.groupId < c2.groupId ? [c1, c2] : [c2, c1];
                const key = `${p1.groupId}-${p2.groupId}`;

                if (!pairStats.has(key)) {
                    pairStats.set(key, {
                        g1Name: p1.groupName,
                        g2Name: p2.groupName,
                        count: 0,
                        lagSum: 0,
                        g1LeadCount: 0,
                        confluenceWins: 0,
                        uniqueG1: new Set(),
                        uniqueG2: new Set()
                    });
                }
                
                const stat = pairStats.get(key)!;
                stat.count++;
                
                // Lag (in milliseconds)
                const diff = Math.abs(c1.time - c2.time);
                stat.lagSum += diff;
                
                // Who led? 
                if (c1.groupId === p1.groupId) {
                    stat.g1LeadCount++;
                    stat.uniqueG1.add(Array.from(byMint.entries()).find(([_, cs]) => cs.includes(c1))?.[0] || '');
                } else {
                    stat.uniqueG2.add(Array.from(byMint.entries()).find(([_, cs]) => cs.includes(c2))?.[0] || '');
                }
                
                // Confluence win
                if (isWin) stat.confluenceWins++;
            }
        }
    }

    // 5. Format Output based on view
    let message = '';
    let keyboard: any[] = [];

    if (view === 'lag') {
        // Lag Matrix View (Default)
        const topPairs = Array.from(pairStats.values())
            .sort((a, b) => b.count - a.count)
            .slice(0, 10);

        if (topPairs.length === 0) {
            return ctx.reply('No cross-group correlations found (no shared calls).');
        }

        message = UIHelper.header('LAG MATRIX (7D)', '⏱️');
        
        for (const p of topPairs) {
            const avgLagMin = (p.lagSum / p.count / 1000 / 60).toFixed(1);
            const g1LeadPct = (p.g1LeadCount / p.count) * 100;
            let relation = '';
            
            if (g1LeadPct > 60) {
                relation = `${p.g1Name} ⚡ leads by ~${avgLagMin}m`;
            } else if (g1LeadPct < 40) {
                relation = `${p.g2Name} ⚡ leads by ~${avgLagMin}m`;
            } else {
                relation = `${p.g1Name} 🤝 ${p.g2Name} (Sync)`;
            }

            message += `🔗 *${p.count} Shared Calls*\n`;
            message += `   ${relation}\n`;
            message += UIHelper.separator('LIGHT');
        }

        keyboard = [
            [{ text: '🤝 Confluence', callback_data: 'confirms_view:confluence' }, { text: '🎯 Unique Ratio', callback_data: 'confirms_view:unique' }],
            [{ text: '🕸️ Cluster Graph', callback_data: 'confirms_view:cluster' }, { text: '👑 Copy-Trade Lead', callback_data: 'confirms_view:lead' }],
            [{ text: '🔙 Back', callback_data: 'analytics' }]
        ];
    }
    else if (view === 'confluence') {
        // Confluence Win Rate
        message = UIHelper.header('CONFLUENCE WIN RATE', '🤝');
        const topPairs = Array.from(pairStats.values())
            .filter(p => p.count >= 3)
            .map(p => ({
                ...p,
                confluenceWR: p.count > 0 ? p.confluenceWins / p.count : 0
            }))
            .sort((a, b) => b.confluenceWR - a.confluenceWR)
            .slice(0, 10);

        for (const p of topPairs) {
            message += `*${p.g1Name} + ${p.g2Name}*\n`;
            message += `   ${p.count} shared calls | ${(p.confluenceWR * 100).toFixed(0)}% Win Rate\n`;
            message += UIHelper.separator('LIGHT');
        }

        keyboard = [[{ text: '🔙 Lag Matrix', callback_data: 'confirms_view:lag' }]];
    }
    else if (view === 'unique') {
        // Unique Signal Ratio
        message = UIHelper.header('UNIQUE SIGNAL RATIO', '🎯');
        const groupStats = Array.from(groupUniqueMints.entries())
            .map(([gid, mints]) => ({
                name: groupMap.get(gid) || 'Unknown',
                uniqueCount: mints.size,
                totalSignals: signals.filter(s => s.groupId === gid).length,
                uniqueRatio: signals.filter(s => s.groupId === gid).length > 0 
                    ? mints.size / signals.filter(s => s.groupId === gid).length 
                    : 0
            }))
            .sort((a, b) => b.uniqueRatio - a.uniqueRatio);

        for (const g of groupStats) {
            const icon = g.uniqueRatio > 0.8 ? '🟢' : g.uniqueRatio > 0.5 ? '🟡' : '🔴';
            message += `${icon} *${g.name}:*\n`;
            message += `   ${(g.uniqueRatio * 100).toFixed(0)}% unique (${g.uniqueCount}/${g.totalSignals})\n`;
            message += UIHelper.separator('LIGHT');
        }

        keyboard = [[{ text: '🔙 Lag Matrix', callback_data: 'confirms_view:lag' }]];
    }
    else if (view === 'cluster') {
        // Cluster Graph
        message = UIHelper.header('CLUSTER GRAPH', '🕸️');
        message += `*Groups that frequently call together:*\n\n`;
        
        const clusters = new Map<string, Set<string>>();
        for (const [key, p] of pairStats.entries()) {
            if (p.count >= 5) {
                const clusterKey = p.g1Name < p.g2Name ? p.g1Name : p.g2Name;
                if (!clusters.has(clusterKey)) {
                    clusters.set(clusterKey, new Set());
                }
                clusters.get(clusterKey)!.add(p.g1Name);
                clusters.get(clusterKey)!.add(p.g2Name);
            }
        }

        for (const [leader, members] of clusters.entries()) {
            if (members.size >= 2) {
                message += `🔗 *Cluster:* ${Array.from(members).join(' ↔ ')}\n`;
                message += `   ${members.size} groups | High correlation\n`;
                message += UIHelper.separator('LIGHT');
            }
        }

        keyboard = [[{ text: '🔙 Lag Matrix', callback_data: 'confirms_view:lag' }]];
    }
    else if (view === 'lead') {
        // Copy-Trade Lead Identification
        message = UIHelper.header('COPY-TRADE LEAD IDENTIFICATION', '👑');
        
        const leadStats = new Map<number, { name: string; leadCount: number; totalPairs: number }>();
        for (const p of pairStats.values()) {
            const g1LeadPct = p.count > 0 ? p.g1LeadCount / p.count : 0;
            const g1Id = Array.from(groupMap.entries()).find(([_, n]: [number, string]) => n === p.g1Name)?.[0];
            const g2Id = Array.from(groupMap.entries()).find(([_, n]: [number, string]) => n === p.g2Name)?.[0];
            
            if (g1LeadPct > 0.6 && g1Id) {
                if (!leadStats.has(g1Id)) {
                    leadStats.set(g1Id, { name: p.g1Name, leadCount: 0, totalPairs: 0 });
                }
                leadStats.get(g1Id)!.leadCount++;
                leadStats.get(g1Id)!.totalPairs++;
            }
            if (g1LeadPct < 0.4 && g2Id) {
                if (!leadStats.has(g2Id)) {
                    leadStats.set(g2Id, { name: p.g2Name, leadCount: 0, totalPairs: 0 });
                }
                leadStats.get(g2Id)!.leadCount++;
                leadStats.get(g2Id)!.totalPairs++;
            }
        }

        const topLeaders = Array.from(leadStats.values())
            .sort((a, b) => b.leadCount - a.leadCount)
            .slice(0, 10);

        for (const leader of topLeaders) {
            const leadRatio = leader.totalPairs > 0 ? leader.leadCount / leader.totalPairs : 0;
            message += `👑 *${leader.name}:*\n`;
            message += `   Leads ${leader.leadCount} pairs | ${(leadRatio * 100).toFixed(0)}% lead rate\n`;
            message += UIHelper.separator('LIGHT');
        }

        keyboard = [[{ text: '🔙 Lag Matrix', callback_data: 'confirms_view:lag' }]];
    }

    await ctx.reply(message, { 
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
    });

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

    const loadingMsg = await ctx.reply('⏳ Loading live data...');

    // 3. Aggregate by Mint (Initial Pass)
    const aggregated = new Map<string, {
        symbol: string;
        mint: string;
        earliestDate: Date;
        earliestCaller: string;
        mentions: number;
        pnl: number;
        currentPrice: number;
        meta?: any; // TokenMeta
    }>();

    for (const sig of signals) {
        if (!aggregated.has(sig.mint)) {
            const caller = sig.user?.username ? `@${sig.user.username}` : (sig.group?.name || 'Unknown');
            aggregated.set(sig.mint, {
                symbol: sig.symbol || 'N/A',
                mint: sig.mint,
                earliestDate: sig.detectedAt,
                earliestCaller: caller,
                mentions: 0,
                pnl: 0,
                currentPrice: 0
            });
        }
        aggregated.get(sig.mint)!.mentions++;
    }

    // 4. Batch Market Cap Fetching (OPTIMIZATION - Using Market Cap instead of Price)
    const uniqueMints = Array.from(aggregated.keys());
    
    // Fetch metadata for all mints to get market caps
    const metaPromises = uniqueMints.map(mint => provider.getTokenMeta(mint));
    const metas = await Promise.all(metaPromises);
    const marketCaps = new Map<string, number>();
    const prices = new Map<string, number>();
    
    for (let i = 0; i < uniqueMints.length; i++) {
      const mint = uniqueMints[i];
      const meta = metas[i];
      if (meta) {
        // Prefer liveMarketCap, then marketCap, then calculate
        let mcap = meta.liveMarketCap || meta.marketCap;
        if (!mcap && meta.supply) {
          const priceQuote = await provider.getQuote(mint).catch(() => null);
          if (priceQuote) {
            prices.set(mint, priceQuote.price);
            mcap = priceQuote.price * meta.supply;
          }
        }
        if (mcap) marketCaps.set(mint, mcap);
      }
    }

    // Apply Filters & Calculate PnL (Pre-Sort) - Using Market Cap
    const liveFilters = ctx.session?.liveFilters || {};
    const minMult = liveFilters.minMult || 0;
    const onlyGainers = liveFilters.onlyGainers || false;
    const sortBy = (liveFilters as any).sortBy || 'pnl';
    
    // Get market cap samples for trending calculation (last 10 minutes)
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const recentSamples = await prisma.priceSample.findMany({
      where: {
        signalId: { in: signals.map(s => s.id) },
        sampledAt: { gte: tenMinutesAgo },
        marketCap: { not: null }
      },
      orderBy: { sampledAt: 'desc' }
    });
    
    // Build market cap history map: signalId -> { current, tenMinAgo }
    const mcapHistory = new Map<number, { current: number; tenMinAgo: number }>();
    for (const sig of signals) {
      const samples = recentSamples.filter(s => s.signalId === sig.id && s.marketCap);
      if (samples.length > 0) {
        const current = samples[0].marketCap || 0;
        const tenMinAgo = samples[samples.length - 1]?.marketCap || current;
        mcapHistory.set(sig.id, { current, tenMinAgo });
      }
    }
    
    // Sort and Filter based on Market Cap (not price)
    const candidates = Array.from(aggregated.values())
        .map(row => {
             const currentMc = marketCaps.get(row.mint) || 0;
             const currentPrice = prices.get(row.mint) || 0;
             row.currentPrice = currentPrice;
             
             // Find entry market cap from earliest signal
             const sig = signals.find(s => s.mint === row.mint);
             const entryMc = sig?.entryMarketCap || 0;
             
             // Calculate PnL based on market cap (preferred)
             if (currentMc > 0 && entryMc > 0) {
                 row.pnl = ((currentMc - entryMc) / entryMc) * 100;
             } else {
                 // Fallback to price if market cap not available
                 const entryPrice = sig?.entryPrice || 0;
                 if (currentPrice > 0 && entryPrice > 0) {
                     row.pnl = ((currentPrice - entryPrice) / entryPrice) * 100;
                 }
             }
             
             // Calculate trending velocity (10min % change in market cap)
             let velocity = 0;
             if (sig) {
               const history = mcapHistory.get(sig.id);
               if (history && history.tenMinAgo > 0) {
                 velocity = ((history.current - history.tenMinAgo) / history.tenMinAgo) * 100;
               }
             }
             (row as any).velocity = velocity;
             (row as any).currentMarketCap = currentMc;
             
             return row;
        })
        .filter(row => {
            if (onlyGainers && row.pnl < 0) return false;
            // MinMult check
            const mult = (row.pnl / 100) + 1;
            if (minMult > 0 && mult < minMult) return false;
            return true;
        });
    
    // Apply sorting based on sortBy
    if (sortBy === 'trending') {
        candidates.sort((a, b) => (b as any).velocity - (a as any).velocity);
    } else if (sortBy === 'newest') {
        candidates.sort((a, b) => b.earliestDate.getTime() - a.earliestDate.getTime());
    } else {
        // Default: Highest PnL
        candidates.sort((a, b) => b.pnl - a.pnl);
    }

    // 5. Lazy Load Metadata (Top 10 Only)
    const top10 = candidates.slice(0, 10);
    const metaMap = new Map<string, any>();
    
    // Parallel fetch for top 10
    await Promise.all(top10.map(async (row) => {
        try {
            const meta = await provider.getTokenMeta(row.mint);
            metaMap.set(row.mint, meta);
        } catch {}
    }));

    // 6. Construct Message
    let message = UIHelper.header('Live Signals (Active)');
    
    if (top10.length === 0) {
        message += '\nNo signals match your filters.';
    }

    for (const row of top10) {
        const meta = metaMap.get(row.mint);
        const sig = signals.find(s => s.mint === row.mint);
        
        // PnL & formatting
        const pnlStr = UIHelper.formatPercent(row.pnl);
        const icon = row.pnl >= 0 ? '🟢' : '🔴';
        const timeAgo = UIHelper.formatTimeAgo(row.earliestDate);
        
        // Use symbol from meta if available
        const displaySymbol = meta?.symbol || row.symbol;
        
        // Card Layout per Plan: Symbol, Entry->Now, Dex/Migrated flags, Age, Caller
        message += `\n${icon} *${displaySymbol}* (${row.symbol || 'N/A'})\n`;
        message += `└ \`${row.mint.slice(0, 8)}...${row.mint.slice(-4)}\`\n`;
        
        // Entry -> Current Market Cap (preferred) or Price (fallback)
        const entryMc = sig?.entryMarketCap || 0;
        const currentMc = (row as any).currentMarketCap || 0;
        let entryStr = 'N/A';
        let currentStr = 'N/A';
        
        if (entryMc > 0 && currentMc > 0) {
          entryStr = `$${(entryMc / 1000).toFixed(1)}k`;
          currentStr = `$${(currentMc / 1000).toFixed(1)}k`;
        } else {
          // Fallback to price
          const entryPrice = sig?.entryPrice || 0;
          entryStr = entryPrice > 0 ? `$${entryPrice.toFixed(6)}` : 'N/A';
          currentStr = row.currentPrice > 0 ? `$${row.currentPrice.toFixed(6)}` : 'N/A';
        }
        message += `💰 Entry MC: ${entryStr} ➔ Now MC: ${currentStr} (*${pnlStr}*)\n`;
        
        // Dex/Migrated/Team flags
        const dexPaid = sig?.dexPaid ? '✅' : '❌';
        const migrated = sig?.migrated ? '✅' : '❌';
        const hasTeam = meta?.audit?.devBalancePercentage && meta.audit.devBalancePercentage < 5 ? '✅' : '❌';
        message += `🍬 Dex: ${dexPaid} | 📦 Migrated: ${migrated} | 👥 Team: ${hasTeam}\n`;
        
        // Age and Caller
        message += `⏱️ Age: ${timeAgo} | 👤 ${row.earliestCaller}\n`;
        message += UIHelper.separator('LIGHT'); 
    }

    // 7. Filters & Sort UI
    const filters = [
        [
            { text: '🔥 Trending', callback_data: 'live_sort:trending' },
            { text: '🆕 Newest', callback_data: 'live_sort:newest' },
            { text: '💰 Highest PnL', callback_data: 'live_sort:pnl' }
        ],
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

    // Edit the loading message
    await ctx.telegram.editMessageText(loadingMsg.chat.id, loadingMsg.message_id, undefined, message, { 
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: filters }
    });

  } catch (error) {
    logger.error('Error loading live signals:', error);
    try { await ctx.reply('Error loading live signals.'); } catch {}
  }
};

export const handleDistributions = async (ctx: Context, view: string = 'mcap') => {
  try {
    const ownerTelegramId = ctx.from?.id ? BigInt(ctx.from.id) : null;
    if (!ownerTelegramId) return ctx.reply('❌ Unable to identify user.');

    const { getDistributionStats } = await import('../../analytics/aggregator');
    const stats = await getDistributionStats(ownerTelegramId, '30D');

    if (stats.totalSignals === 0) {
        return ctx.reply('No data available for distributions yet.', {
            reply_markup: {
                inline_keyboard: [[{ text: '🔙 Back', callback_data: 'analytics' }]]
            }
        });
    }

    let message = '';
    let keyboard: any[] = [];

    // MCap Buckets View (Default)
    if (view === 'mcap') {
        message = UIHelper.header('MARKET CAP STRATEGY (30D)', '📈');
        message += `Target: *Your Workspace*\n`;
        message += UIHelper.separator('HEAVY');
        message += `\`MCap Range   | Win Rate | Avg X \`\n`;
        message += `\`─────────────┼──────────┼───────\`\n`;

        for (const b of stats.mcBuckets) {
            const label = b.label.padEnd(13, ' ');
            const winRate = b.count > 0 ? (b.wins / b.count) * 100 : 0;
            const icon = winRate >= 50 ? '🟢' : winRate >= 30 ? '🟡' : b.count === 0 ? '⚪' : '🔴';
            const winStr = `${icon} ${winRate.toFixed(0)}%`.padEnd(8, ' ');
            const avgStr = `${b.avgMult.toFixed(1)}x`.padEnd(5, ' ');
            message += `\`${label}| ${winStr} | ${avgStr}\`\n`;
        }
        
        const bestBucket = stats.mcBuckets.reduce((prev, curr) => {
            const currWR = curr.count > 0 ? curr.wins / curr.count : 0;
            const prevWR = prev.count > 0 ? prev.wins / prev.count : 0;
            return currWR > prevWR ? curr : prev;
        });
        if (bestBucket.count > 0) {
            const wr = (bestBucket.wins / bestBucket.count) * 100;
            message += UIHelper.separator('HEAVY');
            message += `💡 *BEST RANGE:* ${bestBucket.label.trim()} (${wr.toFixed(0)}% WR)\n`;
        }

        keyboard = [
            [{ text: '🕐 Time of Day', callback_data: 'dist_view:time' }, { text: '📅 Day of Week', callback_data: 'dist_view:day' }],
            [{ text: '👥 Group Compare', callback_data: 'dist_view:groups' }, { text: '📊 Volume', callback_data: 'dist_view:volume' }],
            [{ text: '💀 Rug Ratio', callback_data: 'dist_view:rug' }, { text: '🚀 Moonshot', callback_data: 'dist_view:moonshot' }],
            [{ text: '🔥 Streaks', callback_data: 'dist_view:streak' }, { text: '⏰ Token Age', callback_data: 'dist_view:age' }],
            [{ text: '💧 Liquidity', callback_data: 'dist_view:liquidity' }, { text: '🔙 Back', callback_data: 'analytics' }]
        ];
    }
    // Time of Day Heatmap
    else if (view === 'time') {
        message = UIHelper.header('TIME OF DAY HEATMAP (UTC)', '🕐');
        const bestHours = stats.timeOfDay
            .map((h, i) => ({ hourNum: i, count: h.count, winRate: h.winRate, avgMult: h.avgMult }))
            .filter(h => h.count > 0)
            .sort((a, b) => b.winRate - a.winRate)
            .slice(0, 5);
        
        message += `*Best Hours to Trade:*\n`;
        for (const h of bestHours) {
            message += `${h.hourNum.toString().padStart(2, '0')}:00 UTC: ${(h.winRate * 100).toFixed(0)}% WR (${h.count} calls)\n`;
        }
        keyboard = [[{ text: '🔙 MCap View', callback_data: 'dist_view:mcap' }]];
    }
    // Day of Week Analysis
    else if (view === 'day') {
        message = UIHelper.header('DAY OF WEEK ANALYSIS', '📅');
        for (const d of stats.dayOfWeek) {
            if (d.count > 0) {
                const icon = d.winRate >= 0.5 ? '🟢' : d.winRate >= 0.3 ? '🟡' : '🔴';
                message += `${icon} *${d.day}:* ${(d.winRate * 100).toFixed(0)}% WR | ${d.avgMult.toFixed(1)}x avg | ${d.count} calls\n`;
            }
        }
        keyboard = [[{ text: '🔙 MCap View', callback_data: 'dist_view:mcap' }]];
    }
    // Group vs Group Win Rate
    else if (view === 'groups') {
        message = UIHelper.header('GROUP WIN RATE COMPARISON', '👥');
        const topGroups = stats.groupWinRates.slice(0, 10);
        for (const g of topGroups) {
            message += `*${g.groupName}:* ${(g.winRate * 100).toFixed(0)}% WR | ${g.avgMult.toFixed(1)}x | ${g.count} calls\n`;
        }
        keyboard = [[{ text: '🔙 MCap View', callback_data: 'dist_view:mcap' }]];
    }
    // Volume Correlation
    else if (view === 'volume') {
        message = UIHelper.header('VOLUME CORRELATION', '📊');
        message += `*High Volume (>10k):*\n`;
        message += `  WR: ${(stats.volumeCorrelation.highVolume.winRate * 100).toFixed(0)}% | Avg: ${stats.volumeCorrelation.highVolume.avgMult.toFixed(1)}x | ${stats.volumeCorrelation.highVolume.count} calls\n\n`;
        message += `*Low Volume (<1k):*\n`;
        message += `  WR: ${(stats.volumeCorrelation.lowVolume.winRate * 100).toFixed(0)}% | Avg: ${stats.volumeCorrelation.lowVolume.avgMult.toFixed(1)}x | ${stats.volumeCorrelation.lowVolume.count} calls\n`;
        keyboard = [[{ text: '🔙 MCap View', callback_data: 'dist_view:mcap' }]];
    }
    // Rug Pull Ratio
    else if (view === 'rug') {
        message = UIHelper.header('RUG PULL ANALYSIS', '💀');
        message += `*Rug Pull Ratio:* ${(stats.rugPullRatio * 100).toFixed(1)}%\n`;
        message += `(${Math.round(stats.rugPullRatio * stats.totalSignals)} of ${stats.totalSignals} signals)\n\n`;
        message += `*Definition:* ATH < 0.5x OR Drawdown > 90%\n`;
        keyboard = [[{ text: '🔙 MCap View', callback_data: 'dist_view:mcap' }]];
    }
    // Moonshot Probability
    else if (view === 'moonshot') {
        message = UIHelper.header('MOONSHOT PROBABILITY', '🚀');
        message += `*>10x Hit Rate:* ${(stats.moonshotProbability * 100).toFixed(2)}%\n`;
        message += `(${Math.round(stats.moonshotProbability * stats.totalSignals)} of ${stats.totalSignals} signals)\n\n`;
        message += `*Typical Range:* 1-2% for most callers\n`;
        keyboard = [[{ text: '🔙 MCap View', callback_data: 'dist_view:mcap' }]];
    }
    // Streak Analysis
    else if (view === 'streak') {
        message = UIHelper.header('STREAK ANALYSIS', '🔥');
        message += `*After 3 Losses:*\n`;
        message += `  Next Win Rate: ${(stats.streakAnalysis.after3Losses.winRate * 100).toFixed(0)}% (${stats.streakAnalysis.after3Losses.count} instances)\n\n`;
        message += `*After 3 Wins:*\n`;
        message += `  Next Win Rate: ${(stats.streakAnalysis.after3Wins.winRate * 100).toFixed(0)}% (${stats.streakAnalysis.after3Wins.count} instances)\n`;
        keyboard = [[{ text: '🔙 MCap View', callback_data: 'dist_view:mcap' }]];
    }
    // Token Age Preference
    else if (view === 'age') {
        message = UIHelper.header('TOKEN AGE PREFERENCE', '⏰');
        message += `*New Pairs (0-5m old):*\n`;
        message += `  WR: ${(stats.tokenAgePreference.newPairs.winRate * 100).toFixed(0)}% | Avg: ${stats.tokenAgePreference.newPairs.avgMult.toFixed(1)}x | ${stats.tokenAgePreference.newPairs.count} calls\n\n`;
        message += `*Established (1h+ old):*\n`;
        message += `  WR: ${(stats.tokenAgePreference.established.winRate * 100).toFixed(0)}% | Avg: ${stats.tokenAgePreference.established.avgMult.toFixed(1)}x | ${stats.tokenAgePreference.established.count} calls\n`;
        keyboard = [[{ text: '🔙 MCap View', callback_data: 'dist_view:mcap' }]];
    }
    // Liquidity vs Return
    else if (view === 'liquidity') {
        message = UIHelper.header('LIQUIDITY VS RETURN', '💧');
        message += `*High Liquidity (>50k):*\n`;
        message += `  WR: ${(stats.liquidityVsReturn.highLiquidity.winRate * 100).toFixed(0)}% | Avg: ${stats.liquidityVsReturn.highLiquidity.avgMult.toFixed(1)}x | ${stats.liquidityVsReturn.highLiquidity.count} calls\n\n`;
        message += `*Low Liquidity (<10k):*\n`;
        message += `  WR: ${(stats.liquidityVsReturn.lowLiquidity.winRate * 100).toFixed(0)}% | Avg: ${stats.liquidityVsReturn.lowLiquidity.avgMult.toFixed(1)}x | ${stats.liquidityVsReturn.lowLiquidity.count} calls\n`;
        keyboard = [[{ text: '🔙 MCap View', callback_data: 'dist_view:mcap' }]];
    }

    await ctx.reply(message, { 
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
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

// ----------------------------------------------------------------------
// STRATEGY CREATOR (AI/Algo)
// ----------------------------------------------------------------------

export const handleStrategyCommand = async (ctx: Context, type: 'GROUP' | 'USER', id: string) => {
    try {
        const entityId = parseInt(id);
        // Use 30D stats for strategy analysis
        const { getGroupStats, getUserStats } = await import('../../analytics/aggregator');
        const stats = type === 'GROUP' 
            ? await getGroupStats(entityId, '30D') 
            : await getUserStats(entityId, '30D');

        if (!stats) return ctx.reply('No data available to generate strategy.');

        // Algorithmic Strategy Generation
        let strategyName = 'Balanced';
        let riskLevel = 'Medium';
        let action = 'Copy Trade';
        const advice: string[] = [];

        // 1. Analyze Win Rate vs Reward
        if (stats.winRate > 0.6 && stats.avgMultiple < 2.5) {
            strategyName = 'High-Frequency Scalper';
            advice.push('• This source calls many winners but with smaller gains.');
            advice.push('• Strategy: Take Profit quickly at 30-50%. Do not hold for moon.');
            riskLevel = 'Low';
        } else if (stats.winRate < 0.3 && stats.avgMultiple > 5) {
            strategyName = 'Lotto Hunter';
            advice.push('• Low win rate but huge winners. Expect losing streaks.');
            advice.push('• Strategy: Use small size (0.1 SOL). Hold moonbags for >10x.');
            riskLevel = 'High';
        } else {
            strategyName = 'Balanced Trader';
            advice.push('• Decent mix of reliability and upside.');
            advice.push('• Strategy: Standard copy trade settings.');
        }

        // 2. Analyze Risk (Rug Rate & Drawdown)
        if (stats.rugRate > 0.1) {
            riskLevel = 'Very High 💀';
            advice.push('• WARNING: High Rug Rate (>10%). Verify CA before buying.');
            action = 'Manual Review (Do Not Auto-Copy)';
        } else if (stats.consistency < 1.0) { // Low StdDev
            advice.push('• Very consistent performance. Safe for automated copy trading.');
        }

        // 3. Analyze Behavior (MCap & Sniper)
        if (stats.mcapAvg < 15000) {
            advice.push('• Specializes in Micro-Caps (<$15k).');
            advice.push('• Execution speed is critical. Use high gas/priority fees.');
        }
        if (stats.sniperScore > 80 || stats.speedScore > 80) {
            advice.push('• Enters extremely early (Sniper Mode).');
            advice.push('• Manual entry will likely be dumped on. Needs a fast bot.');
        }
        
        // 4. Lifespan & Diamond Hands
        if (stats.diamondHands > 0.5) {
            advice.push('• Diamond Handed Caller: Holds >24h frequently.');
            advice.push('• Strategy: Good for swing trading. Don\'t panic sell early dips.');
        } else if (stats.avgLifespan < 1) { // < 1 hour
            advice.push('• Quick Flipper: Calls die within 1 hour.');
            advice.push('• Strategy: Scalp only. Get in, take 20-30%, get out.');
        }

        // 5. Construct Output
        let message = UIHelper.header('STRATEGY REPORT', '🪄');
        message += `Target: *${stats.name}*\n`;
        message += UIHelper.separator('HEAVY');
        
        message += `🧠 *Archetype:* ${strategyName}\n`;
        message += `⚠️ *Risk Level:* ${riskLevel}\n`;
        message += `🤖 *Recommended Action:* ${action}\n\n`;
        
        message += `*📝 Execution Plan:*\n`;
        advice.forEach(line => message += `${line}\n`);
        
        message += UIHelper.separator('LIGHT');
        message += `*📊 Key Stats (30D):*\n`;
        message += `• Win Rate: ${(stats.winRate * 100).toFixed(0)}%\n`;
        message += `• Avg X: ${stats.avgMultiple.toFixed(2)}x\n`;
        message += `• Rug Rate: ${(stats.rugRate * 100).toFixed(1)}%`;

        await ctx.reply(message, { 
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[{ text: '❌ Close', callback_data: 'delete_msg' }]]
            }
        });

    } catch (error) {
        logger.error('Error generating strategy:', error);
        ctx.reply('Error generating strategy.');
    }
};
