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

export const handleGroupStatsCommand = async (ctx: Context, groupIdStr?: string) => {
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

    const stats = await getGroupStats(targetGroupId, 'ALL');
    if (!stats) {
      return ctx.reply('Group not found or no data available.');
    }

    const message = formatEntityStats(stats, 'GROUP');
    
    await ctx.reply(message, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '7D Stats', callback_data: `group_stats_window:${targetGroupId}:7D` },
            { text: '30D Stats', callback_data: `group_stats_window:${targetGroupId}:30D` },
          ],
          [
            { text: '🔙 Back', callback_data: 'analytics_groups' },
          ],
        ],
      },
    });
  } catch (error) {
    logger.error('Error in /groupstats command:', error);
    ctx.reply('Error fetching group stats.');
  }
};

export const handleUserStatsCommand = async (ctx: Context, userIdStr?: string) => {
  try {
    if (!userIdStr) {
        const user = await prisma.user.findUnique({ where: { userId: BigInt(ctx.from!.id) }});
        if (user) userIdStr = user.id.toString();
        else return ctx.reply("You are not registered in the system yet.");
    }
    
    const targetUserId = parseInt(userIdStr || '0');
    const stats = await getUserStats(targetUserId, 'ALL');

    if (!stats) {
      return ctx.reply('User not found or no data available.');
    }

    const message = formatEntityStats(stats, 'USER');

    await ctx.reply(message, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
           [
            { text: '7D Stats', callback_data: `user_stats_window:${targetUserId}:7D` },
            { text: '30D Stats', callback_data: `user_stats_window:${targetUserId}:30D` },
          ],
          [
            { text: '🔙 Back', callback_data: 'analytics' },
          ],
        ],
      },
    });
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
    statsList.forEach((s, i) => {
        const rank = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i+1}.`;
        message += `${rank} *${s.name}*\n`;
        message += `   💎 ${s.avgMultiple.toFixed(2)}x Avg | 🎯 ${(s.winRate*100).toFixed(0)}% WR | Score: ${s.score.toFixed(0)}\n\n`;
    });

    await ctx.reply(message, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '7D', callback_data: 'leaderboard_groups:7D' },
                    { text: '30D', callback_data: 'leaderboard_groups:30D' },
                    { text: 'ALL', callback_data: 'leaderboard_groups:ALL' },
                ],
                [{ text: '👤 User Leaderboard', callback_data: 'leaderboard_users:30D' }],
                [{ text: '🔙 Analytics', callback_data: 'analytics' }],
            ]
        }
    });

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
    statsList.forEach((s, i) => {
        const rank = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i+1}.`;
        message += `${rank} *${s.name}*\n`;
        message += `   💎 ${s.avgMultiple.toFixed(2)}x Avg | 🎯 ${(s.winRate*100).toFixed(0)}% WR | Score: ${s.score.toFixed(0)}\n\n`;
    });

    await ctx.reply(message, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '7D', callback_data: 'leaderboard_users:7D' },
                    { text: '30D', callback_data: 'leaderboard_users:30D' },
                    { text: 'ALL', callback_data: 'leaderboard_users:ALL' },
                ],
                [{ text: '👥 Group Leaderboard', callback_data: 'leaderboard_groups:30D' }],
                [{ text: '🔙 Analytics', callback_data: 'analytics' }],
            ]
        }
    });
  } catch (error) {
    logger.error('Error in user leaderboard:', error);
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

export const handleRecentCalls = async (ctx: Context) => {
  try {
    const ownerTelegramId = ctx.from?.id ? BigInt(ctx.from.id) : null;
    if (!ownerTelegramId) return ctx.reply('❌ Unable to identify user.');

    // 1. First, fetch the top recent signals to identify what we need to update
    const recentSignals = await prisma.signal.findMany({
      where: {
        group: { owner: { userId: ownerTelegramId } },
      },
      orderBy: { detectedAt: 'desc' },
      take: 6,
      select: { id: true, mint: true }
    });

    if (recentSignals.length === 0) {
      return ctx.reply('No signals yet in your workspace.');
    }

    // 2. Notify user we are loading fresh data
    const loadingMsg = await ctx.reply('⏳ Calculating latest metrics (ATH/DD)... please wait.');

    // 3. Force synchronous update for these specific signals
    // This ensures we have the latest Bitquery data before displaying
    try {
        const signalIds = recentSignals.map(s => s.id);
        await updateHistoricalMetrics(signalIds);
    } catch (err) {
        logger.error('Targeted update failed during recent calls view:', err);
        // Continue anyway to show what we have
    }

    // 4. Fetch full data (now with updated metrics)
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
              const displayCaller = callerName ? `@${callerName}` : (sig.group?.name || 'Unknown Channel');

              message += `• *${sig.name || sig.symbol || sig.mint}* (${sig.symbol || 'N/A'})\n`;
              message += `  Group: ${sig.group?.name || sig.group?.chatId || 'N/A'}\n`;
              message += `  Caller: ${displayCaller}\n`;
              message += `  Entry: $${entryPrice ? entryPrice.toFixed(6) : 'Pending'} | Cur: ${multiple ? `${multiple.toFixed(2)}x` : 'N/A'}\n`;
              message += `  ATH: \`${athMult.toFixed(2)}x\` | DD: \`${(drawdown * 100).toFixed(0)}%\`\n`;
              message += `  Mint: \`${sig.mint}\`\n\n`;
            }

    // 5. Update the loading message with the result
    // We use editMessageText because we sent a text message earlier.
    // If handleRecentCalls is called via callback, we might want to edit that instead, 
    // but usually we reply a new message for "Loading...". 
    // If called via callback (ctx.callbackQuery), we should delete loadingMsg and send new one, or edit loadingMsg.
    
    await ctx.telegram.editMessageText(loadingMsg.chat.id, loadingMsg.message_id, undefined, message.trim(), { parse_mode: 'Markdown' });
    
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
