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
  if (stats.totalSignals < 10) {
    msg += `   ⚠️ *Low sample size — results may be noisy*\n`;
  }
  msg += `   ✅ *Win Rate:* ${UIHelper.formatPercent(stats.winRate * 100)} ${UIHelper.progressBar(stats.winRate * 100, 100, 6)}\n`;
  msg += `   💎 *Moon Rate:* ${UIHelper.formatPercent(stats.winRate5x * 100)} (>5x)\n`;
  msg += `   📈 *Avg ROI:* ${UIHelper.formatMultiple(stats.avgMultiple)}\n`;
  msg += `   ⏱️ *Time to ATH:* ${UIHelper.formatDurationMinutes(stats.avgTimeToAth)}\n`;
  msg += `   ⚡ *Time to 2x/5x/10x:* ${UIHelper.formatDurationMinutes(stats.avgTimeTo2x)} / ${UIHelper.formatDurationMinutes(stats.avgTimeTo5x)} / ${UIHelper.formatDurationMinutes(stats.avgTimeTo10x)}\n`;
  msg += `   💤 *Stagnation Time:* ${UIHelper.formatDurationMinutes(stats.avgStagnationTime)}\n`;
  msg += `   🎯 *Hits:* ${stats.hit2Count} >2x | ${stats.hit5Count} >5x | ${stats.hit10Count} >10x\n`;

  msg += UIHelper.subHeader('RISK PROFILE', '🔹');
  msg += `   🎲 *Consistency:* ${stats.consistency.toFixed(2)} (StdDev)\n`;
  msg += `   📉 *Avg Drawdown:* ${UIHelper.formatPercent(stats.avgDrawdown * 100)}\n`;
  msg += `   ⏳ *Avg Drawdown Duration:* ${UIHelper.formatDurationMinutes(stats.avgDrawdownDuration)}\n`;
  msg += `   💀 *Rug Rate:* ${UIHelper.formatPercent(stats.rugRate * 100)}\n`;

  msg += UIHelper.subHeader('BEHAVIORAL ANALYSIS', '🔹');
  msg += `   💰 *Avg Entry MC:* ${UIHelper.formatMarketCap(stats.avgEntryMarketCap)}\n`;
  msg += `   🏔️ *Avg ATH MC:* ${UIHelper.formatMarketCap(stats.avgAthMarketCap)}\n`;
  msg += `   ⚡ *Sniper Score:* ${stats.sniperScore.toFixed(0)}%\n`;
  msg += `   🚀 *Speed Score:* ${stats.speedScore.toFixed(0)}/100\n`;
  msg += `   💎 *Diamond Hands:* ${(stats.diamondHands * 100).toFixed(0)}%\n`;
  msg += `   📄 *Paper Hands:* ${(stats.paperHands * 100).toFixed(0)}%\n`;
  msg += `   ⏳ *Avg Lifespan:* ${UIHelper.formatDurationMinutes(stats.avgLifespan)}\n`;
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

export const handleGroupStatsCommand = async (ctx: Context, groupIdStr?: string, window: '1D' | '3D' | '7D' | '30D' | 'ALL' | string = 'ALL') => {
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

    if (!(ctx as any).session) (ctx as any).session = {};
    if (!(ctx as any).session.stats) (ctx as any).session.stats = {};
    if (!(ctx as any).session.stats.group) (ctx as any).session.stats.group = {};
    const storedWindow = (ctx as any).session.stats.group[targetGroupId];
    const effectiveWindow = window || storedWindow || 'ALL';
    (ctx as any).session.stats.group[targetGroupId] = effectiveWindow;

    const stats = await getGroupStats(targetGroupId, effectiveWindow as any);
    if (!stats) {
      // If callback, answer it
      if (ctx.callbackQuery) await ctx.answerCbQuery('Group not found or no data available.');
      else await ctx.reply('Group not found or no data available.');
      return;
    }

    const windowLabel = ['1D','3D','7D','30D','ALL'].includes(String(effectiveWindow)) ? String(effectiveWindow) : `Custom (${effectiveWindow})`;
    const message = formatEntityStats(stats, 'GROUP') + `\n📅 Timeframe: *${windowLabel}*`;
    
    const keyboard = {
        inline_keyboard: [
          [
            { text: effectiveWindow === '1D' ? '✅ 1D' : '1D', callback_data: `group_stats_window:${targetGroupId}:1D` },
            { text: effectiveWindow === '3D' ? '✅ 3D' : '3D', callback_data: `group_stats_window:${targetGroupId}:3D` },
            { text: effectiveWindow === '7D' ? '✅ 7D' : '7D', callback_data: `group_stats_window:${targetGroupId}:7D` },
            { text: effectiveWindow === '30D' ? '✅ 30D' : '30D', callback_data: `group_stats_window:${targetGroupId}:30D` },
            { text: effectiveWindow === 'ALL' ? '✅ ALL' : 'ALL', callback_data: `group_stats_window:${targetGroupId}:ALL` },
            { text: 'Custom', callback_data: `group_stats_custom:${targetGroupId}` },
          ],
          [
             { text: '🪄 Strategy', callback_data: `strategy_view:GROUP:${targetGroupId}` },
             { text: '🔙 Back', callback_data: 'analytics_groups' },
             { text: '❌ Close', callback_data: 'delete_msg' },
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

export const handleUserStatsCommand = async (ctx: Context, userIdStr?: string, window: '1D' | '3D' | '7D' | '30D' | 'ALL' | string = 'ALL') => {
  try {
    if (!userIdStr) {
        const user = await prisma.user.findUnique({ where: { userId: BigInt(ctx.from!.id) }});
        if (user) userIdStr = user.id.toString();
        else return ctx.reply("You are not registered in the system yet.");
    }
    
    const targetUserId = parseInt(userIdStr || '0');
    if (!(ctx as any).session) (ctx as any).session = {};
    if (!(ctx as any).session.stats) (ctx as any).session.stats = {};
    if (!(ctx as any).session.stats.user) (ctx as any).session.stats.user = {};
    const storedWindow = (ctx as any).session.stats.user[targetUserId];
    const effectiveWindow = window || storedWindow || 'ALL';
    (ctx as any).session.stats.user[targetUserId] = effectiveWindow;

    const stats = await getUserStats(targetUserId, effectiveWindow as any);

    if (!stats) {
      if (ctx.callbackQuery) await ctx.answerCbQuery('User not found or no data available.');
      else await ctx.reply('User not found or no data available.');
      return;
    }

    const windowLabel = ['1D','3D','7D','30D','ALL'].includes(String(effectiveWindow)) ? String(effectiveWindow) : `Custom (${effectiveWindow})`;
    const message = formatEntityStats(stats, 'USER') + `\n📅 Timeframe: *${windowLabel}*`;

    const keyboard = {
        inline_keyboard: [
          [
            { text: effectiveWindow === '1D' ? '✅ 1D' : '1D', callback_data: `user_stats_window:${targetUserId}:1D` },
            { text: effectiveWindow === '3D' ? '✅ 3D' : '3D', callback_data: `user_stats_window:${targetUserId}:3D` },
            { text: effectiveWindow === '7D' ? '✅ 7D' : '7D', callback_data: `user_stats_window:${targetUserId}:7D` },
            { text: effectiveWindow === '30D' ? '✅ 30D' : '30D', callback_data: `user_stats_window:${targetUserId}:30D` },
            { text: effectiveWindow === 'ALL' ? '✅ ALL' : 'ALL', callback_data: `user_stats_window:${targetUserId}:ALL` },
            { text: 'Custom', callback_data: `user_stats_custom:${targetUserId}` },
          ],
          [
            { text: '🪄 Strategy', callback_data: `strategy_view:USER:${targetUserId}` },
            { text: '🔙 Back', callback_data: 'analytics_users_input' }, // Go back to user list
            { text: '❌ Close', callback_data: 'delete_msg' },
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

export const handleGroupLeaderboardCommand = async (ctx: Context, window: '1D' | '3D' | '7D' | '30D' | 'ALL' | string = '30D') => {
  try {
    const statsList = await getLeaderboard('GROUP', window, 'SCORE', 10);
    
    if (statsList.length === 0) {
        return ctx.reply(`No group data available for ${window}.`);
    }

    const windowLabel = ['1D','3D','7D','30D','ALL'].includes(String(window)) ? String(window) : `Custom ${window}`;
    let message = `🏆 *Top Groups (${windowLabel})*\n_Sorted by Reliability Score_\n\n`;
    
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
                { text: '1D', callback_data: 'leaderboard_groups:1D' },
                { text: '3D', callback_data: 'leaderboard_groups:3D' },
                { text: '7D', callback_data: 'leaderboard_groups:7D' },
                { text: '30D', callback_data: 'leaderboard_groups:30D' },
                { text: 'ALL', callback_data: 'leaderboard_groups:ALL' },
                { text: 'Custom', callback_data: 'leaderboard_custom:GROUP' },
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

export const handleUserLeaderboardCommand = async (ctx: Context, window: '1D' | '3D' | '7D' | '30D' | 'ALL' | string = '30D') => {
  try {
    const statsList = await getLeaderboard('USER', window, 'SCORE', 10);
    
    if (statsList.length === 0) {
        return ctx.reply(`No user data available for ${window}.`);
    }

    const windowLabel = ['1D','3D','7D','30D','ALL'].includes(String(window)) ? String(window) : `Custom ${window}`;
    let message = `🏆 *Top Callers (${windowLabel})*\n_Sorted by Reliability Score_\n\n`;
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
                { text: '1D', callback_data: 'leaderboard_users:1D' },
                { text: '3D', callback_data: 'leaderboard_users:3D' },
                { text: '7D', callback_data: 'leaderboard_users:7D' },
                { text: '30D', callback_data: 'leaderboard_users:30D' },
                { text: 'ALL', callback_data: 'leaderboard_users:ALL' },
                { text: 'Custom', callback_data: 'leaderboard_custom:USER' },
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

export const handleSignalLeaderboardCommand = async (ctx: Context, window: '1D' | '3D' | '7D' | '30D' | 'ALL' | string = '30D') => {
  try {
    const { getSignalLeaderboard } = await import('../../analytics/aggregator');
    const signals = await getSignalLeaderboard(window, 10);
    
    if (signals.length === 0) {
        return ctx.reply(`No signal data available for ${window}.`);
    }

    const windowLabel = ['1D','3D','7D','30D','ALL'].includes(String(window)) ? String(window) : `Custom ${window}`;
    let message = `💎 *Top Signals (${windowLabel})*\n_Sorted by ATH Multiple_\n\n`;
    const signalButtons: any[] = [];

    signals.forEach((s, i) => {
        const rank = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i+1}.`;
        message += `${rank} *${s.symbol}* (${s.athMultiple.toFixed(2)}x)\n`;
        message += `   Caller: ${s.sourceName} | 📅 ${s.detectedAt.toLocaleDateString()}\n`;
        
        // Entry MC, ATH MC, Current MC, Time to ATH
        const entryMcStr = s.entryMarketCap ? UIHelper.formatMarketCap(s.entryMarketCap) : 'N/A';
        const athMcStr = s.athMarketCap ? UIHelper.formatMarketCap(s.athMarketCap) : 'N/A';
        const currentMcStr = s.currentMarketCap ? UIHelper.formatMarketCap(s.currentMarketCap) : 'N/A';
        const timeToAthStr = s.timeToAth ? s.timeToAth < 60 ? `${Math.round(s.timeToAth)}m` : `${(s.timeToAth / 60).toFixed(1)}h` : 'N/A';
        
        message += `   Entry MC: ${entryMcStr} | ATH MC: ${athMcStr} | Now MC: ${currentMcStr}\n`;
        message += `   Time to ATH: ${timeToAthStr}\n`;
        message += `   \`${s.mint}\`\n\n`;

        if (i < 5) {
            signalButtons.push([{ text: `${rank} ${s.symbol} Stats`, callback_data: `stats:${s.id}` }]);
        }
    });

    const keyboard = {
        inline_keyboard: [
            ...signalButtons,
            [
                { text: '1D', callback_data: 'leaderboard_signals:1D' },
                { text: '3D', callback_data: 'leaderboard_signals:3D' },
                { text: '7D', callback_data: 'leaderboard_signals:7D' },
                { text: '30D', callback_data: 'leaderboard_signals:30D' },
                { text: 'ALL', callback_data: 'leaderboard_signals:ALL' },
                { text: 'Custom', callback_data: 'leaderboard_custom:SIGNAL' },
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
            [{ text: '🔙 Back', callback_data: 'analytics' }, { text: '❌ Close', callback_data: 'delete_msg' }]
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

        keyboard = [[{ text: '🔙 Lag Matrix', callback_data: 'confirms_view:lag' }, { text: '❌ Close', callback_data: 'delete_msg' }]];
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

        keyboard = [[{ text: '🔙 Lag Matrix', callback_data: 'confirms_view:lag' }, { text: '❌ Close', callback_data: 'delete_msg' }]];
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

        keyboard = [[{ text: '🔙 Lag Matrix', callback_data: 'confirms_view:lag' }, { text: '❌ Close', callback_data: 'delete_msg' }]];
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

        keyboard = [[{ text: '🔙 Lag Matrix', callback_data: 'confirms_view:lag' }, { text: '❌ Close', callback_data: 'delete_msg' }]];
    }

    if (ctx.callbackQuery && ctx.callbackQuery.message) {
        await ctx.editMessageText(message, { 
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: keyboard }
        });
    } else {
    await ctx.reply(message, { 
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
    });
    }

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
        trackingStatus: { in: ['ACTIVE', 'ENTRY_PENDING'] },
        OR: [
            { chatId: { in: ownedChatIds } },
            { id: { in: forwardedSignalIds } }
        ]
      },
      orderBy: { detectedAt: 'asc' }, // Oldest first to find "Earliest Caller"
      include: {
        group: true,
        user: true,
        metrics: true,
        priceSamples: { orderBy: { sampledAt: 'asc' }, take: 1 },
      }
    });

    if (signals.length === 0) {
      return ctx.reply('No active signals right now.', {
          reply_markup: {
              inline_keyboard: [[{ text: '🔙 Back', callback_data: 'analytics' }]]
          }
      });
    }

    // Check if we're updating an existing message (from filter/sort action)
    let loadingMsg: any = null;
    if (ctx.callbackQuery && ctx.callbackQuery.message) {
      // Edit existing message instead of creating new one
      loadingMsg = ctx.callbackQuery.message;
      try {
        await ctx.telegram.editMessageText(
          loadingMsg.chat.id,
          loadingMsg.message_id,
          undefined,
          '⏳ Loading live data...',
          { parse_mode: 'Markdown' }
        );
      } catch {}
    } else {
      loadingMsg = await ctx.reply('⏳ Loading live data...');
    }

    // 3. Aggregate by Mint (Initial Pass)
    const aggregated = new Map<string, {
        symbol: string;
        mint: string;
        earliestDate: Date;
        latestDate: Date;
        earliestCaller: string;
        earliestSignalId: number;
        latestSignalId: number;
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
                latestDate: sig.detectedAt,
                earliestCaller: caller,
                earliestSignalId: sig.id,
                latestSignalId: sig.id,
                mentions: 0,
                pnl: 0,
                currentPrice: 0
            });
        }
        const row = aggregated.get(sig.mint)!;
        row.mentions++;
        if (sig.detectedAt < row.earliestDate) row.earliestDate = sig.detectedAt;
        if (sig.detectedAt > row.latestDate) row.latestDate = sig.detectedAt;
        if (sig.detectedAt <= row.earliestDate) row.earliestSignalId = sig.id;
        if (sig.detectedAt >= row.latestDate) row.latestSignalId = sig.id;
    }

    // 4. OPTIMIZATION: Use cached metrics instead of fetching prices for all signals
    // This prevents timeout when there are many active signals
    const uniqueMints = Array.from(aggregated.keys());
    const marketCaps = new Map<string, number>();
    const prices = new Map<string, number>();
    
    // Use cached currentMarketCap from signal.metrics (updated by background jobs)
    for (const mint of uniqueMints) {
      const sig = signals.find(s => s.mint === mint);
      if (sig?.metrics?.currentMarketCap) {
        marketCaps.set(mint, sig.metrics.currentMarketCap);
        // Calculate approximate price from market cap for display
        if (sig.entrySupply && sig.entrySupply > 0) {
          prices.set(mint, sig.metrics.currentMarketCap / sig.entrySupply);
        }
      }
    }

    // Apply Filters & Calculate PnL (Pre-Sort) - Using Market Cap
    const liveFilters = ctx.session?.liveFilters || {};
    const minMult = liveFilters.minMult || 0;
    const onlyGainers = liveFilters.onlyGainers || false;
    const sortBy = (liveFilters as any).sortBy || 'pnl';
    const timeframeLabel = (liveFilters as any).timeframe || '24H';
    const timeframeParsed = UIHelper.parseTimeframeInput(timeframeLabel);
    const timeframeCutoff =
      timeframeLabel === 'ALL'
        ? new Date(0)
        : (timeframeParsed ? new Date(Date.now() - timeframeParsed.ms) : subDays(new Date(), 1));
    const minAth = (liveFilters as any).minAth || 0;
    
    // OPTIMIZATION: Removed expensive priceSample query that was causing timeouts
    // Velocity calculation removed - can be re-added later using cached metrics if needed
    // For now, trending sort will use PnL instead of velocity
    
    // Sort and Filter based on Market Cap (not price)
    const candidates = Array.from(aggregated.values())
        .map(row => {
             // Find entry market cap from earliest signal
             const sig = signals.find(s => s.id === (row as any).earliestSignalId) || signals.find(s => s.mint === row.mint);
             const currentMc = marketCaps.get(row.mint) ?? sig?.metrics?.currentMarketCap ?? 0;
             const currentPrice = prices.get(row.mint) ?? 0;
             row.currentPrice = currentPrice;
             
             // Find entry market cap from earliest signal
             const entryMc = sig?.entryMarketCap || sig?.priceSamples?.[0]?.marketCap || 0;
             
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

             // Current multiple (market cap preferred)
             const currentMultiple = entryMc > 0 && currentMc > 0 ? currentMc / entryMc : (sig?.metrics?.currentMultiple || 0);
             (row as any).currentMultiple = currentMultiple;
             
             // FIX: Use ATH multiple from metrics (real ATH from OHLCV), not current multiple
             // ATH is the maximum MC from entry to now, calculated by background jobs
             const athMult = sig?.metrics?.athMultiple || 0;
             (row as any).athMultiple = athMult;
             
             // Velocity calculation removed to prevent timeout
             // Use PnL-based trending instead (high PnL = trending up)
             (row as any).velocity = row.pnl; // Fallback: use PnL as velocity proxy
             (row as any).currentMarketCap = currentMc;
             
             return row;
        })
        .filter(row => {
            if (onlyGainers && row.pnl < 0) return false;
            // FIX: > 2x / > 5x filters should use ATH multiple, not current multiple
            // ATH multiple shows the peak performance from entry to now
            const athMult = (row as any).athMultiple || 0;
            if (minMult > 0) {
              if (athMult <= 0 || athMult < minMult) return false;
              // When filtering by 2x/5x, only include signals called within selected timeframe
              if (row.latestDate < timeframeCutoff) return false;
            }
            // ATH threshold filter
            if (minAth > 0) {
              const ath = (row as any).athMultiple || 0;
              if (ath < minAth) return false;
            }
            // Timeframe filter for general view
            if (row.latestDate < timeframeCutoff) return false;
            return true;
        });
    
    // Apply sorting based on sortBy
    if (sortBy === 'trending') {
        candidates.sort((a, b) => (b as any).velocity - (a as any).velocity);
    } else if (sortBy === 'newest') {
        candidates.sort((a, b) => b.latestDate.getTime() - a.latestDate.getTime());
    } else {
        // Default: Highest PnL
        candidates.sort((a, b) => b.pnl - a.pnl);
    }

    // 5. Lazy Load Metadata (Top 10 Only) - Also update market caps with fresh data
    const top10 = candidates.slice(0, 10);
    const metaMap = new Map<string, any>();
    
    // Parallel fetch for top 10 - also get fresh market caps
    await Promise.all(top10.map(async (row) => {
        try {
            const meta = await provider.getTokenMeta(row.mint);
            metaMap.set(row.mint, meta);
            
            // Update market cap with fresh data
            const freshMc = meta.liveMarketCap || meta.marketCap;
            if (freshMc) {
                marketCaps.set(row.mint, freshMc);
                (row as any).currentMarketCap = freshMc;
            } else if (meta.supply) {
                // Try to get price from market cap if available
                const currentMc = marketCaps.get(row.mint);
                if (currentMc && meta.supply > 0) {
                    const calculatedPrice = currentMc / meta.supply;
                    prices.set(row.mint, calculatedPrice);
                } else if (meta.livePrice) {
                    const calculatedMc = meta.livePrice * meta.supply;
                    marketCaps.set(row.mint, calculatedMc);
                    (row as any).currentMarketCap = calculatedMc;
                    prices.set(row.mint, meta.livePrice);
                }
            }
            
            // FIX: Recalculate PnL after updating market cap with fresh metadata
            // This ensures PnL reflects the latest market cap values
            const sig = signals.find(s => s.id === (row as any).earliestSignalId) || signals.find(s => s.mint === row.mint);
            if (sig) {
                const entryMc = sig.entryMarketCap || sig.priceSamples?.[0]?.marketCap || 0;
                const currentMc = (row as any).currentMarketCap || 0;
                if (currentMc > 0 && entryMc > 0) {
                    row.pnl = ((currentMc - entryMc) / entryMc) * 100;
                }
            }
        } catch {}
    }));

    // 6. Construct Message
    let message = UIHelper.header('Live Signals (Active)');
    
    if (top10.length === 0) {
        message += '\nNo signals match your filters.';
    }

    for (const row of top10) {
        const meta = metaMap.get(row.mint);
        const sig = signals.find(s => s.id === (row as any).earliestSignalId) || signals.find(s => s.mint === row.mint);
        if (!sig) continue;
        if (meta) {
          const updates: any = {};
          const tokenCreatedAt = meta.createdAt || meta.firstPoolCreatedAt || null;
          if (!sig.tokenCreatedAt && tokenCreatedAt) updates.tokenCreatedAt = tokenCreatedAt;
          if (!sig.socials && meta.socialLinks) updates.socials = meta.socialLinks;
          if (!sig.entrySupply && meta.supply) updates.entrySupply = meta.supply;
          if (Object.keys(updates).length > 0) {
            prisma.signal.update({ where: { id: sig.id }, data: updates }).catch(() => {});
          }
        }
        
        // Entry -> Current Market Cap (preferred) or Price (fallback)
        // FIX: Use the same values that were used to calculate row.pnl for consistency
        const entryMc = sig?.entryMarketCap || sig?.priceSamples?.[0]?.marketCap || null;
        const currentMc = (row as any).currentMarketCap || sig?.metrics?.currentMarketCap || null;
        
        // FIX: Recalculate PnL if it's missing or zero, using the display values
        // This ensures PnL matches what's displayed
        if ((!row.pnl || row.pnl === 0) && currentMc && entryMc && entryMc > 0) {
            row.pnl = ((currentMc - entryMc) / entryMc) * 100;
        }
        
        // PnL & formatting
        // FIX: Icon should be green if positive compared to entry MC, red if negative
        const pnlStr = UIHelper.formatPercent(row.pnl || 0);
        const icon = (row.pnl || 0) >= 0 ? '🟢' : '🔴';
        const timeAgo = UIHelper.formatTimeAgo(row.latestDate);
        
        // Use symbol from meta if available
        const displaySymbol = meta?.symbol || row.symbol;
        
        // Card Layout per Plan: Symbol, Entry->Now, Dex/Migrated flags, Age, Caller
        message += `\n${icon} *${displaySymbol}* (${row.symbol || 'N/A'})\n`;
        message += `└ \`${row.mint.slice(0, 8)}...${row.mint.slice(-4)}\`\n`;
        const entryStr = entryMc ? UIHelper.formatMarketCap(entryMc) : 'N/A';
        const currentStr = currentMc ? UIHelper.formatMarketCap(currentMc) : 'N/A';
        
        // FIX: Use ATH multiple from metrics (real ATH from OHLCV data, not current/entry ratio)
        // ATH multiple is calculated by background jobs using OHLCV data from entry to now
        const athMult = (row as any).athMultiple || sig?.metrics?.athMultiple || 0;
        const athLabel = athMult > 0
          ? `${athMult.toFixed(1).replace(/\.0$/, '')}x ATH`
          : 'ATH N/A';
        message += `💰 Entry MC: ${entryStr} ➔ Now MC: ${currentStr} (*${pnlStr}*) | ${athLabel}\n`;
        
        if (!sig?.entryMarketCap && sig?.priceSamples?.[0]?.marketCap) {
          prisma.signal.update({
            where: { id: sig.id },
            data: { entryMarketCap: sig.priceSamples[0].marketCap, trackingStatus: 'ACTIVE' },
          }).catch(() => {});
        }

        // Dex/Migrated/Team/X flags
        const dexPaid = sig?.dexPaid
          ? '✅'
          : (meta?.tags || []).some((t: string) => t.toLowerCase().includes('dex'))
            ? '✅'
            : '❔';
        const migrated = sig?.migrated
          ? '✅'
          : (meta?.audit?.devMigrations || 0) > 0
            ? '✅'
            : '❔';
        const hasTeam = meta?.audit?.devBalancePercentage !== undefined
          ? (meta.audit.devBalancePercentage < 5 ? '✅' : '❌')
          : '❔';
        const hasX = meta?.socialLinks ? (meta.socialLinks.twitter ? '✅' : '❌') : '❔';
        message += `🍬 Dex: ${dexPaid} | 📦 Migrated: ${migrated} | 👥 Team: ${hasTeam} | 𝕏: ${hasX}\n`;

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
            { text: timeframeLabel === '1H' ? '✅ 1H' : '1H', callback_data: 'live_time:1H' },
            { text: timeframeLabel === '6H' ? '✅ 6H' : '6H', callback_data: 'live_time:6H' },
            { text: timeframeLabel === '24H' ? '✅ 24H' : '24H', callback_data: 'live_time:24H' },
            { text: timeframeLabel === '7D' ? '✅ 7D' : '7D', callback_data: 'live_time:7D' },
            { text: timeframeLabel === 'ALL' ? '✅ ALL' : 'ALL', callback_data: 'live_time:ALL' },
            { text: 'Custom', callback_data: 'live_time:custom' }
        ],
        [
            { text: minAth ? `🏔️ ATH ≥ ${minAth}x` : '🏔️ ATH ≥ X', callback_data: 'live_ath:custom' },
            { text: minAth ? '♻️ Reset ATH' : ' ', callback_data: minAth ? 'live_ath:reset' : 'live_signals' }
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
    if (!(ctx as any).session) (ctx as any).session = {};
    const session = (ctx as any).session;
    if (!session.distributions) {
      session.distributions = { timeframe: '30D', targetType: 'OVERALL' };
    }
    const timeframe = session.distributions.timeframe || '30D';
    const targetType = session.distributions.targetType || 'OVERALL';
    const targetId = session.distributions.targetId;
    let targetLabel = 'Overall';
    if (targetType === 'GROUP' && targetId) {
      const group = await prisma.group.findUnique({ where: { id: targetId } });
      if (group) targetLabel = `Group: ${group.name || group.chatId}`;
    } else if (targetType === 'USER' && targetId) {
      const user = await prisma.user.findUnique({ where: { id: targetId } });
      if (user) targetLabel = `User: ${user.username ? `@${user.username}` : (user.firstName || `User ${user.id}`)}`;
    }

    if (ctx.chat?.id) {
      session.distributions.lastChatId = Number(ctx.chat.id);
    }
    if (ctx.callbackQuery && ctx.callbackQuery.message) {
      session.distributions.lastMessageId = (ctx.callbackQuery.message as any).message_id;
    }

    const stats = await getDistributionStats(ownerTelegramId, timeframe, { type: targetType, id: targetId });

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
        message = UIHelper.header(`DISTRIBUTIONS (${timeframe})`, '📈');
        message += `Target: *${targetLabel}*\n`;
        message += `Based on *${stats.totalSignals}* calls\n`;
        if (stats.totalSignals < 10) {
            message += `⚠️ *Low sample size — results may be noisy*\n`;
        }
        message += UIHelper.separator('HEAVY');
        message += `\`MCap Range   | Win Rate | Avg X | Count\`\n`;
        message += `\`─────────────┼──────────┼───────┼──────\`\n`;

        for (const b of stats.mcBuckets) {
            const label = b.label.padEnd(13, ' ');
            const winRate = b.count > 0 ? (b.wins / b.count) * 100 : 0;
            const icon = winRate >= 50 ? '🟢' : winRate >= 30 ? '🟡' : b.count === 0 ? '⚪' : '🔴';
            const winStr = `${icon} ${winRate.toFixed(0)}%`.padEnd(8, ' ');
            const avgStr = `${b.avgMult.toFixed(1)}x`.padEnd(5, ' ');
            const countStr = `${b.count}`.padEnd(4, ' ');
            message += `\`${label}| ${winStr} | ${avgStr} | ${countStr}\`\n`;
        }
        
        const bestBucket = stats.mcBuckets.reduce((prev, curr) => {
            const currWR = curr.count > 0 ? curr.wins / curr.count : 0;
            const prevWR = prev.count > 0 ? prev.wins / prev.count : 0;
            return currWR > prevWR ? curr : prev;
        });
        if (bestBucket.count > 0) {
            const wr = (bestBucket.wins / bestBucket.count) * 100;
            message += UIHelper.separator('HEAVY');
            message += `💡 *BEST RANGE (Win Rate):* ${bestBucket.label.trim()} (${wr.toFixed(0)}% WR)\n`;
        }

        keyboard = [
            [{ text: `🎯 Target: ${targetType === 'OVERALL' ? 'Overall' : targetType === 'GROUP' ? 'Group' : 'User'}`, callback_data: 'dist_target' }],
            [
              { text: timeframe === '1D' ? '✅ 1D' : '1D', callback_data: 'dist_time:1D' },
              { text: timeframe === '7D' ? '✅ 7D' : '7D', callback_data: 'dist_time:7D' },
              { text: timeframe === '30D' ? '✅ 30D' : '30D', callback_data: 'dist_time:30D' },
              { text: timeframe === 'ALL' ? '✅ ALL' : 'ALL', callback_data: 'dist_time:ALL' },
              { text: 'Custom', callback_data: 'dist_time:custom' }
            ],
            [{ text: '🕐 Time of Day', callback_data: 'dist_view:time' }, { text: '📅 Day of Week', callback_data: 'dist_view:day' }],
            [{ text: '👥 Group Compare', callback_data: 'dist_view:groups' }, { text: '📊 Volume', callback_data: 'dist_view:volume' }],
            [{ text: '💀 Rug Ratio', callback_data: 'dist_view:rug' }, { text: '🚀 Moonshot', callback_data: 'dist_view:moonshot' }],
            [{ text: '🔥 Streaks', callback_data: 'dist_view:streak' }, { text: '⏰ Token Age', callback_data: 'dist_view:age' }],
            [{ text: '💧 Liquidity', callback_data: 'dist_view:liquidity' }, { text: '🔙 Back', callback_data: 'analytics' }, { text: '❌ Close', callback_data: 'delete_msg' }]
        ];
    }
    // Time of Day Heatmap
    else if (view === 'time') {
        message = UIHelper.header('TIME OF DAY (UTC)', '🕐');
        message += `Timezone: *UTC*\n`;
        const bestHours = stats.timeOfDay
            .map((h, i) => ({ hourNum: i, count: h.count, winRate: h.winRate, avgMult: h.avgMult }))
            .filter(h => h.count > 0)
            .sort((a, b) => b.winRate - a.winRate)
            .slice(0, 5);

        message += UIHelper.separator('LIGHT');
        if (bestHours.length === 0) {
          message += `No hourly distribution data yet.\n`;
        } else {
          message += `*Top Hours:*\n`;
          for (const h of bestHours) {
              message += `• ${h.hourNum.toString().padStart(2, '0')}:00 — ${(h.winRate * 100).toFixed(0)}% WR | ${h.avgMult.toFixed(1)}x | ${h.count} calls\n`;
          }
        }
        message += UIHelper.separator('HEAVY');
        message += `\`Hour | WR  | Avg | Calls | Heat\`\n`;
        message += `\`─────┼─────┼─────┼──────┼────\`\n`;
        stats.timeOfDay.forEach((h, i) => {
            const hour = i.toString().padStart(2, '0');
            const wr = h.count > 0 ? (h.winRate * 100).toFixed(0).padStart(3, ' ') : '  -';
            const avg = h.count > 0 ? h.avgMult.toFixed(1).padStart(3, ' ') : ' - ';
            const calls = `${h.count}`.padStart(4, ' ');
            const heat = h.count === 0 ? '░' : h.winRate >= 0.65 ? '▮▮▮' : h.winRate >= 0.5 ? '▮▮' : h.winRate >= 0.35 ? '▮' : '░';
            message += `\`${hour}  | ${wr}% | ${avg} | ${calls} | ${heat}\`\n`;
        });
        keyboard = [[{ text: '🔙 MCap View', callback_data: 'dist_view:mcap' }, { text: '❌ Close', callback_data: 'delete_msg' }]];
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
        keyboard = [
          [
            { text: 'Mon', callback_data: 'dist_view:day_hour:Mon' },
            { text: 'Tue', callback_data: 'dist_view:day_hour:Tue' },
            { text: 'Wed', callback_data: 'dist_view:day_hour:Wed' },
            { text: 'Thu', callback_data: 'dist_view:day_hour:Thu' },
          ],
          [
            { text: 'Fri', callback_data: 'dist_view:day_hour:Fri' },
            { text: 'Sat', callback_data: 'dist_view:day_hour:Sat' },
            { text: 'Sun', callback_data: 'dist_view:day_hour:Sun' },
          ],
          [{ text: '🔙 MCap View', callback_data: 'dist_view:mcap' }, { text: '❌ Close', callback_data: 'delete_msg' }],
        ];
    }
    else if (view.startsWith('day_hour:')) {
        const day = view.split(':')[1];
        const entry = stats.timeOfDayByDay.find(d => d.day === day);
        message = UIHelper.header(`HOURLY BY ${day}`, '🕒');
        if (!entry) {
          message += `No data for ${day}.\n`;
        } else {
          const best = [...entry.hours].filter(h => h.count > 0).sort((a, b) => b.winRate - a.winRate)[0];
          if (best) {
            message += `Best Hour: *${best.hour.toString().padStart(2, '0')}:00* — ${(best.winRate * 100).toFixed(0)}% WR (${best.count} calls)\n`;
            message += UIHelper.separator('LIGHT');
          }
          message += `\`Hour | WR  | Avg | Calls | Heat\`\n`;
          message += `\`─────┼─────┼─────┼──────┼────\`\n`;
          entry.hours.forEach(h => {
            const hour = h.hour.toString().padStart(2, '0');
            const wr = h.count > 0 ? (h.winRate * 100).toFixed(0).padStart(3, ' ') : '  -';
            const avg = h.count > 0 ? h.avgMult.toFixed(1).padStart(3, ' ') : ' - ';
            const calls = `${h.count}`.padStart(4, ' ');
            const heat = h.count === 0 ? '░' : h.winRate >= 0.65 ? '▮▮▮' : h.winRate >= 0.5 ? '▮▮' : h.winRate >= 0.35 ? '▮' : '░';
            message += `\`${hour}  | ${wr}% | ${avg} | ${calls} | ${heat}\`\n`;
          });
        }
        keyboard = [[{ text: '🔙 Day of Week', callback_data: 'dist_view:day' }, { text: '❌ Close', callback_data: 'delete_msg' }]];
    }
    // Group vs Group Win Rate
    else if (view === 'groups') {
        message = UIHelper.header('GROUP WIN RATE COMPARISON', '👥');
        const topGroups = stats.groupWinRates.slice(0, 10);
        for (const g of topGroups) {
            message += `*${g.groupName}:* ${(g.winRate * 100).toFixed(0)}% WR | ${g.avgMult.toFixed(1)}x | ${g.count} calls\n`;
            message += `   Avg Entry MC: ${UIHelper.formatMarketCap(g.avgEntryMc)} | Avg ATH: ${g.avgAthMult.toFixed(1)}x\n`;
            message += `   Avg Time to ATH: ${UIHelper.formatDurationMinutes(g.avgTimeToAth)} | Moon Rate: ${(g.moonRate * 100).toFixed(0)}%\n`;
        }
        keyboard = [[{ text: '🔙 MCap View', callback_data: 'dist_view:mcap' }, { text: '❌ Close', callback_data: 'delete_msg' }]];
    }
    // Volume Correlation
    else if (view === 'volume') {
        message = UIHelper.header('VOLUME CORRELATION', '📊');
        message += `\`Volume     | Win Rate | Avg X | Count\`\n`;
        message += `\`───────────┼──────────┼───────┼──────\`\n`;
        for (const b of stats.volumeBuckets) {
          const winRate = b.count > 0 ? (b.wins / b.count) * 100 : 0;
          const icon = winRate >= 50 ? '🟢' : winRate >= 30 ? '🟡' : b.count === 0 ? '⚪' : '🔴';
          const label = b.label.padEnd(9, ' ');
          const winStr = `${icon} ${winRate.toFixed(0)}%`.padEnd(8, ' ');
          const avgStr = `${b.avgMult.toFixed(1)}x`.padEnd(5, ' ');
          const countStr = `${b.count}`.padEnd(4, ' ');
          message += `\`${label} | ${winStr} | ${avgStr} | ${countStr}\`\n`;
        }
        message += `\n_Note: Volume data depends on provider coverage._\n`;
        keyboard = [[{ text: '🔙 MCap View', callback_data: 'dist_view:mcap' }, { text: '❌ Close', callback_data: 'delete_msg' }]];
    }
    // Rug Pull Ratio
    else if (view === 'rug') {
        message = UIHelper.header('RUG PULL ANALYSIS', '💀');
        message += `*Rug Pull Ratio:* ${(stats.rugPullRatio * 100).toFixed(1)}%\n`;
        message += `(${Math.round(stats.rugPullRatio * stats.totalSignals)} of ${stats.totalSignals} signals)\n\n`;
        message += `*Definition:* ATH < 0.5x OR Drawdown > 90%\n`;
        message += `_Time constraint not applied (no time-to-rug data yet)._`;
        keyboard = [[{ text: '🔙 MCap View', callback_data: 'dist_view:mcap' }, { text: '❌ Close', callback_data: 'delete_msg' }]];
    }
    // Moonshot Probability
    else if (view === 'moonshot') {
        message = UIHelper.header('MOONSHOT PROBABILITY', '🚀');
        message += `>2x: ${(stats.totalSignals ? (stats.moonshotCounts.gt2x / stats.totalSignals) * 100 : 0).toFixed(1)}% (${stats.moonshotCounts.gt2x})\n`;
        message += `>5x: ${(stats.totalSignals ? (stats.moonshotCounts.gt5x / stats.totalSignals) * 100 : 0).toFixed(1)}% (${stats.moonshotCounts.gt5x})\n`;
        message += `>10x: ${(stats.totalSignals ? (stats.moonshotCounts.gt10x / stats.totalSignals) * 100 : 0).toFixed(1)}% (${stats.moonshotCounts.gt10x})\n\n`;
        message += `⏱️ Avg Time to 2x/5x/10x: ${UIHelper.formatDurationMinutes(stats.moonshotTimes.timeTo2x)} / ${UIHelper.formatDurationMinutes(stats.moonshotTimes.timeTo5x)} / ${UIHelper.formatDurationMinutes(stats.moonshotTimes.timeTo10x)}\n`;
        keyboard = [[{ text: '🔙 MCap View', callback_data: 'dist_view:mcap' }, { text: '❌ Close', callback_data: 'delete_msg' }]];
    }
    // Streak Analysis
    else if (view === 'streak') {
        message = UIHelper.header('STREAK ANALYSIS', '🔥');
        message += `*After Losses:* 1L ${(stats.streakAnalysis.after1Loss.winRate * 100).toFixed(0)}% (${stats.streakAnalysis.after1Loss.count}) | 2L ${(stats.streakAnalysis.after2Losses.winRate * 100).toFixed(0)}% (${stats.streakAnalysis.after2Losses.count}) | 3L ${(stats.streakAnalysis.after3Losses.winRate * 100).toFixed(0)}% (${stats.streakAnalysis.after3Losses.count})\n`;
        message += `*After Wins:* 1W ${(stats.streakAnalysis.after1Win.winRate * 100).toFixed(0)}% (${stats.streakAnalysis.after1Win.count}) | 2W ${(stats.streakAnalysis.after2Wins.winRate * 100).toFixed(0)}% (${stats.streakAnalysis.after2Wins.count}) | 3W ${(stats.streakAnalysis.after3Wins.winRate * 100).toFixed(0)}% (${stats.streakAnalysis.after3Wins.count})\n\n`;
        message += `*Current Streak:* ${stats.currentStreak.count} ${stats.currentStreak.type === 'win' ? 'wins' : 'losses'}\n`;
        keyboard = [[{ text: '🔙 MCap View', callback_data: 'dist_view:mcap' }, { text: '❌ Close', callback_data: 'delete_msg' }]];
    }
    // Token Age Preference
    else if (view === 'age') {
        message = UIHelper.header('TOKEN AGE PREFERENCE', '⏰');
        if (!stats.tokenAgeHasData) {
          message += `Token age data is not available for this dataset.\n`;
          message += `_Note: token age requires creation timestamps; once available, buckets will populate._\n`;
        } else {
          message += `\`Age        | Win Rate | Avg X | Count\`\n`;
          message += `\`───────────┼──────────┼───────┼──────\`\n`;
          for (const b of stats.tokenAgeBuckets) {
            const winRate = b.count > 0 ? (b.wins / b.count) * 100 : 0;
            const icon = winRate >= 50 ? '🟢' : winRate >= 30 ? '🟡' : b.count === 0 ? '⚪' : '🔴';
            const label = b.label.padEnd(9, ' ');
            const winStr = `${icon} ${winRate.toFixed(0)}%`.padEnd(8, ' ');
            const avgStr = `${b.avgMult.toFixed(1)}x`.padEnd(5, ' ');
            const countStr = `${b.count}`.padEnd(4, ' ');
            message += `\`${label} | ${winStr} | ${avgStr} | ${countStr}\`\n`;
          }
          message += `\n_Note: token age inferred from creation timestamps when available._\n`;
        }
        keyboard = [[{ text: '🔙 MCap View', callback_data: 'dist_view:mcap' }, { text: '❌ Close', callback_data: 'delete_msg' }]];
    }
    // Liquidity vs Return
    else if (view === 'liquidity') {
        message = UIHelper.header('LIQUIDITY VS RETURN', '💧');
        message += `\`Liquidity  | Win Rate | Avg X | Count\`\n`;
        message += `\`───────────┼──────────┼───────┼──────\`\n`;
        for (const b of stats.liquidityBuckets) {
          const winRate = b.count > 0 ? (b.wins / b.count) * 100 : 0;
          const icon = winRate >= 50 ? '🟢' : winRate >= 30 ? '🟡' : b.count === 0 ? '⚪' : '🔴';
          const label = b.label.padEnd(9, ' ');
          const winStr = `${icon} ${winRate.toFixed(0)}%`.padEnd(8, ' ');
          const avgStr = `${b.avgMult.toFixed(1)}x`.padEnd(5, ' ');
          const countStr = `${b.count}`.padEnd(4, ' ');
          message += `\`${label} | ${winStr} | ${avgStr} | ${countStr}\`\n`;
        }
        keyboard = [[{ text: '🔙 MCap View', callback_data: 'dist_view:mcap' }, { text: '❌ Close', callback_data: 'delete_msg' }]];
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

const resolveSince = (window: string): Date | null => {
  const normalized = window.toUpperCase();
  if (normalized === 'ALL') return null;
  if (normalized === '1D') return subDays(new Date(), 1);
  if (normalized === '3D') return subDays(new Date(), 3);
  if (normalized === '7D') return subDays(new Date(), 7);
  if (normalized === '30D') return subDays(new Date(), 30);
  const parsed = UIHelper.parseTimeframeInput(normalized);
  if (parsed) return new Date(Date.now() - parsed.ms);
  return subDays(new Date(), 7);
};

export const handleRecentCalls = async (ctx: Context, window: string = '7D') => {
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

    if (!(ctx as any).session) (ctx as any).session = {};
    if (!(ctx as any).session.recent) (ctx as any).session.recent = {};
    const storedWindow = (ctx as any).session.recent.timeframe;
    const effectiveWindow = window || storedWindow || '7D';
    (ctx as any).session.recent.timeframe = effectiveWindow;
    const since = resolveSince(effectiveWindow);

    // 2. Fetch Signals (Fetch more to allow for deduplication)
    const rawSignals = await prisma.signal.findMany({
      where: {
        OR: [
            { chatId: { in: ownedChatIds } },
            { id: { in: forwardedSignalIds } }
        ],
        ...(since ? { detectedAt: { gte: since } } : {}),
      },
      orderBy: { detectedAt: 'desc' },
      take: 40, // Fetch 40, display top 10 unique
      include: {
        group: true,
        user: true, 
        metrics: true, 
        priceSamples: { orderBy: { sampledAt: 'asc' }, take: 1 },
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
    const loadingMsg = await ctx.reply('⏳ Syncing latest market data...');
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
        include: { group: true, user: true, metrics: true, priceSamples: { orderBy: { sampledAt: 'asc' }, take: 1 } }
    });

    const windowLabel = ['1D','3D','7D','30D','ALL'].includes(String(effectiveWindow)) ? String(effectiveWindow) : `Custom ${effectiveWindow}`;
    let message = UIHelper.header(`RECENT ACTIVITY LOG (${windowLabel})`, '📜');

    const { getMultipleTokenPrices } = await import('../../providers/jupiter');
    const prices = await getMultipleTokenPrices(signals.map(s => s.mint));
    const metaMap = new Map<string, any>();
    await Promise.all(signals.map(async (s) => {
        try {
        const meta = await provider.getTokenMeta(s.mint);
        metaMap.set(s.mint, meta);
        } catch {}
    }));

    for (const sig of signals) {
        const currentPrice = prices[sig.mint] || 0;
        const entryMc = sig.entryMarketCap || sig.priceSamples?.[0]?.marketCap || 0;
        const meta = metaMap.get(sig.mint);
        const supply = sig.entrySupply || meta?.supply || null;
        const currentMc = supply && currentPrice ? currentPrice * supply : (sig.metrics?.currentMarketCap || meta?.marketCap || 0);
        const entryStr = entryMc ? UIHelper.formatMarketCap(entryMc) : 'N/A';
        const currStr = currentMc ? UIHelper.formatMarketCap(currentMc) : 'N/A';
        
        const pnl = entryMc > 0 && currentMc > 0 ? ((currentMc - entryMc) / entryMc) * 100 : 0;
        const pnlStr = UIHelper.formatPercent(pnl);
        const icon = UIHelper.getStatusIcon(pnl);
        
        const ath = sig.metrics?.athMultiple || 0;
        const drawdown = sig.metrics?.maxDrawdown ? sig.metrics.maxDrawdown * 100 : 0;
        const athSupply = sig.entrySupply || (sig.entryMarketCap && sig.entryPrice ? sig.entryMarketCap / sig.entryPrice : null);
        const athMc = sig.metrics?.athMarketCap || (sig.metrics?.athPrice && athSupply ? sig.metrics.athPrice * athSupply : 0);
        const timeTo2x = UIHelper.formatDurationMinutes(sig.metrics?.timeTo2x ? sig.metrics.timeTo2x / (1000 * 60) : null);
        const timeTo5x = UIHelper.formatDurationMinutes(sig.metrics?.timeTo5x ? sig.metrics.timeTo5x / (1000 * 60) : null);
        const timeTo10x = UIHelper.formatDurationMinutes(sig.metrics?.timeTo10x ? sig.metrics.timeTo10x / (1000 * 60) : null);

        // Attribution
        const time = sig.detectedAt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
        const source = sig.user?.username 
            ? `👤 @${sig.user.username}` 
            : `📢 ${sig.group?.name || 'Unknown Channel'}`;
        
        message += `🕒 *${time}* | ${icon} *${sig.symbol || 'UNKNOWN'}*\n`;
        message += `   via ${source}\n`;
        message += `   💰 Entry MC: ${entryStr} ➔ Now MC: ${currStr} (${pnlStr})\n`;
        message += `   🏔️ ATH: ${ath > 0 ? `${ath.toFixed(2)}x` : 'N/A'} | ATH MC: ${athMc ? UIHelper.formatMarketCap(athMc) : 'N/A'} | 📉 Drawdown: ${drawdown ? `${drawdown.toFixed(0)}%` : 'N/A'}\n`;
        message += `   ⏱️ Time to 2x/5x/10x: ${timeTo2x} / ${timeTo5x} / ${timeTo10x}\n`;
        message += UIHelper.separator('LIGHT');
    }

    await ctx.telegram.editMessageText(loadingMsg.chat.id, loadingMsg.message_id, undefined, message, { 
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [
                  { text: '1D', callback_data: 'recent_window:1D' },
                  { text: '3D', callback_data: 'recent_window:3D' },
                  { text: '7D', callback_data: 'recent_window:7D' },
                  { text: '30D', callback_data: 'recent_window:30D' },
                  { text: 'ALL', callback_data: 'recent_window:ALL' },
                  { text: 'Custom', callback_data: 'recent_window:custom' },
                ],
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
