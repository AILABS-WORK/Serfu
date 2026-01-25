import { Context } from 'telegraf';
import { subDays } from 'date-fns';
import { prisma } from '../../../db';
import { logger } from '../../../utils/logger';
import { getGroupStats, getUserStats, getLeaderboard, EntityStats } from '../../../analytics/aggregator';
import { optimizeTpSl } from '../../../analytics/backtest';
import { updateHistoricalMetrics } from '../../../jobs/historicalMetrics';
import { UIHelper } from '../../../utils/ui';

export const handleAnalyticsCommand = async (ctx: Context) => {
  try {
    const title = UIHelper.header('Analytics Dashboard');

    await ctx.reply(title, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '🏆 Leaderboards', callback_data: 'leaderboards_menu' },
            { text: '👥 My Groups', callback_data: 'analytics_groups' }
          ],
          [
            { text: '🟢 Live Signals', callback_data: 'live_signals' },
            { text: '📜 Recent Calls', callback_data: 'analytics_recent' }
          ],
          [
            { text: '📊 Distributions', callback_data: 'distributions' },
            { text: '👤 User Stats', callback_data: 'analytics_users_input' }
          ],
          [
            { text: '🚀 Earliest Callers', callback_data: 'analytics_earliest' },
            { text: '🔁 Cross-Group Confirms', callback_data: 'analytics_confirms' }
          ],
          [
            { text: '🔄 Refresh Metrics', callback_data: 'analytics_refresh' }
          ],
          [
            { text: '🧠 Full Metrics Backfill', callback_data: 'analytics_backfill' },
            { text: '📈 Backfill Progress', callback_data: 'analytics_backfill_status' }
          ]
        ]
      }
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
          { text: 'Custom', callback_data: `group_stats_custom:${targetGroupId}` }
        ],
        [
          { text: '🪄 Strategy', callback_data: `strategy_view:GROUP:${targetGroupId}` },
          { text: '🔙 Back', callback_data: 'analytics_groups' },
          { text: '❌ Close', callback_data: 'delete_msg' }
        ]
      ]
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
          { text: 'Custom', callback_data: `user_stats_custom:${targetUserId}` }
        ],
        [
          { text: '🪄 Strategy', callback_data: `strategy_view:USER:${targetUserId}` },
          { text: '🔙 Back', callback_data: 'analytics_users_input' },
          { text: '❌ Close', callback_data: 'delete_msg' }
        ]
      ]
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

export const handleEarliestCallers = async (ctx: Context) => {
  try {
    const ownerTelegramId = ctx.from?.id ? BigInt(ctx.from.id) : null;
    if (!ownerTelegramId) return ctx.reply('❌ Unable to identify user.');
    const since = subDays(new Date(), 7);

    const userGroups = await prisma.group.findMany({
      where: { owner: { userId: ownerTelegramId }, isActive: true },
      select: { id: true, chatId: true, type: true }
    });
    const ownedChatIds = userGroups.map((g: any) => g.chatId);

    const signals = await prisma.signal.findMany({
      where: {
        detectedAt: { gte: since },
        chatId: { in: ownedChatIds },
        metrics: { athMultiple: { gte: 2.0 } }
      },
      select: { id: true, mint: true, detectedAt: true, userId: true, group: true, user: true, metrics: true, symbol: true, groupId: true }
    });

    if (signals.length === 0) {
      return ctx.reply('No high-quality earliest calls (>2x) found in your workspace recently.');
    }

    const firstByMint = new Map<string, {
      userId: number | null;
      groupId: number | null;
      detectedAt: Date;
      multiple: number;
      symbol: string;
      mint: string;
    }>();

    signals
      .sort((a: any, b: any) => a.detectedAt.getTime() - b.detectedAt.getTime())
      .forEach((s: any) => {
        if (!firstByMint.has(s.mint)) {
          firstByMint.set(s.mint, {
            userId: s.userId,
            groupId: s.groupId,
            detectedAt: s.detectedAt,
            multiple: s.metrics?.athMultiple || 0,
            symbol: s.symbol || '?',
            mint: s.mint
          });
        }
      });

    const userCounts = new Map<string, { count: number; totalMult: number; wins: number }>();

    for (const entry of firstByMint.values()) {
      let key = 'Unknown';
      let name = 'Unknown';

      if (entry.userId) {
        const sig = signals.find((s: any) => s.userId === entry.userId && s.mint === entry.mint);
        if (sig && sig.user) {
          key = `user:${sig.userId}`;
          name = sig.user.username ? `@${sig.user.username}` : (sig.user.firstName || 'User');
        }
      } else {
        const sig = signals.find((s: any) => !s.userId && s.mint === entry.mint);
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
    }

    const top = Array.from(userCounts.entries())
      .map(([key, stat]) => {
        let name = 'Unknown';
        if (key.startsWith('user:')) {
          const uid = parseInt(key.split(':')[1]);
          const u = signals.find((s: any) => s.userId === uid)?.user;
          name = u?.username ? `@${u.username}` : (u?.firstName || 'User');
        } else {
          const gid = parseInt(key.split(':')[1]);
          const g = signals.find((s: any) => s.group?.id === gid)?.group;
          name = g?.name || 'Channel';
        }
        return { name, ...stat, avg: stat.totalMult / stat.count };
      })
      .sort((a: any, b: any) => b.count - a.count)
      .slice(0, 10);

    let message = '🚀 *Top \"First Callers\" (>2x Wins)*\n_Who finds the gems first in your workspace?_\n\n';
    top.forEach((t: any, idx: number) => {
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

    const userGroups = await prisma.group.findMany({
      where: { owner: { userId: ownerTelegramId }, isActive: true },
      select: { id: true, chatId: true, type: true, name: true }
    });

    if (userGroups.length < 2) {
      return ctx.reply('You need to monitor at least 2 groups to see cross-group correlations.');
    }

    const ownedChatIds = userGroups.map((g: any) => g.chatId);
    const destinationGroupIds = userGroups.filter((g: any) => g.type === 'destination').map((g: any) => g.id);
    let forwardedSignalIds: number[] = [];
    if (destinationGroupIds.length > 0) {
      const forwarded = await prisma.forwardedSignal.findMany({
        where: { destGroupId: { in: destinationGroupIds.map((id: number) => BigInt(id)) } },
        select: { signalId: true }
      });
      forwardedSignalIds = forwarded.map((f: any) => f.signalId);
    }

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

    const byMint = new Map<string, Array<{ groupId: number; groupName: string; time: number }>>();
    for (const s of signals) {
      if (!s.groupId) continue;
      if (!byMint.has(s.mint)) byMint.set(s.mint, []);
      const list = byMint.get(s.mint)!;
      if (!list.find(x => x.groupId === s.groupId)) {
        list.push({
          groupId: s.groupId,
          groupName: s.group?.name || `Group ${s.groupId}`,
          time: s.detectedAt.getTime()
        });
      }
    }

    const pairStats = new Map<string, {
      g1Name: string;
      g2Name: string;
      count: number;
      lagSum: number;
      g1LeadCount: number;
      confluenceWins: number;
      uniqueG1: Set<string>;
      uniqueG2: Set<string>;
    }>();

    const groupIds = userGroups.map((g: any) => g.id);
    const groupMap = new Map(userGroups.map((g: any) => [g.id, g.name || `Group ${g.chatId}`]));
    const sevenDaysAgo = subDays(new Date(), 7);
    const groupUniqueMints = new Map<number, Set<string>>();
    for (const gid of groupIds) {
      groupUniqueMints.set(gid, new Set());
    }

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
      calls.sort((a: any, b: any) => a.time - b.time);
      const isWin = mintWinMap.get(mint) || false;

      for (let i = 0; i < calls.length; i++) {
        for (let j = i + 1; j < calls.length; j++) {
          const c1 = calls[i];
          const c2 = calls[j];
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

          const diff = Math.abs(c1.time - c2.time);
          stat.lagSum += diff;

          if (c1.groupId === p1.groupId) {
            stat.g1LeadCount++;
            stat.uniqueG1.add(mint);
          } else {
            stat.uniqueG2.add(mint);
          }

          if (isWin) stat.confluenceWins++;
        }
      }
    }

    let message = '';
    let keyboard: any[] = [];

    if (view === 'lag') {
      const topPairs = Array.from(pairStats.values())
        .sort((a: any, b: any) => b.count - a.count)
        .slice(0, 10);

      if (topPairs.length === 0) {
        return ctx.reply('No cross-group correlations found (no shared calls).');
      }

      message = UIHelper.header('LAG MATRIX (7D)', '⏱️');
      for (const p of topPairs) {
        const avgLagMin = (p.lagSum / p.count / 1000 / 60).toFixed(1);
        const g1LeadPct = (p.g1LeadCount / p.count) * 100;
        let relation = '';

        if (g1LeadPct > 60) relation = `${p.g1Name} ⚡ leads by ~${avgLagMin}m`;
        else if (g1LeadPct < 40) relation = `${p.g2Name} ⚡ leads by ~${avgLagMin}m`;
        else relation = `${p.g1Name} 🤝 ${p.g2Name} (Sync)`;

        message += `🔗 *${p.count} Shared Calls*\n`;
        message += `   ${relation}\n`;
        message += UIHelper.separator('LIGHT');
      }

      keyboard = [
        [{ text: '🤝 Confluence', callback_data: 'confirms_view:confluence' }, { text: '🎯 Unique Ratio', callback_data: 'confirms_view:unique' }],
        [{ text: '🕸️ Cluster Graph', callback_data: 'confirms_view:cluster' }, { text: '👑 Copy-Trade Lead', callback_data: 'confirms_view:lead' }],
        [{ text: '🔙 Back', callback_data: 'analytics' }, { text: '❌ Close', callback_data: 'delete_msg' }]
      ];
    } else {
      message = UIHelper.header('CONFLUENCE WIN RATE', '🤝');
      const topPairs = Array.from(pairStats.values())
        .filter(p => p.count >= 3)
        .map(p => ({
          ...p,
          confluenceWR: p.count > 0 ? p.confluenceWins / p.count : 0
        }))
        .sort((a: any, b: any) => b.confluenceWR - a.confluenceWR)
        .slice(0, 10);

      for (const p of topPairs) {
        message += `*${p.g1Name} + ${p.g2Name}*\n`;
        message += `   ${p.count} shared calls | ${(p.confluenceWR * 100).toFixed(0)}% Win Rate\n`;
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

export const handleStrategyCommand = async (ctx: Context, type: 'GROUP' | 'USER', id: string) => {
  try {
    const entityId = parseInt(id);
    const stats = type === 'GROUP'
      ? await getGroupStats(entityId, '30D')
      : await getUserStats(entityId, '30D');

    if (!stats) return ctx.reply('No data available to generate strategy.');

    let strategyName = 'Balanced';
    let riskLevel = 'Medium';
    let action = 'Copy Trade';
    const advice: string[] = [];

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

    if (stats.rugRate > 0.1) {
      riskLevel = 'Very High 💀';
      advice.push('• WARNING: High Rug Rate (>10%). Verify CA before buying.');
      action = 'Manual Review (Do Not Auto-Copy)';
    } else if (stats.consistency < 1.0) {
      advice.push('• Very consistent performance. Safe for automated copy trading.');
    }

    if (stats.mcapAvg < 15000) {
      advice.push('• Specializes in Micro-Caps (<$15k).');
      advice.push('• Execution speed is critical. Use high gas/priority fees.');
    }
    if (stats.sniperScore > 80 || stats.speedScore > 80) {
      advice.push('• Enters extremely early (Sniper Mode).');
      advice.push('• Manual entry will likely be dumped on. Needs a fast bot.');
    }

    if (stats.diamondHands > 0.5) {
      advice.push('• Diamond Handed Caller: Holds >24h frequently.');
      advice.push('• Strategy: Good for swing trading. Don\'t panic sell early dips.');
    } else if (stats.avgLifespan < 1) {
      advice.push('• Quick Flipper: Calls die within 1 hour.');
      advice.push('• Strategy: Scalp only. Get in, take 20-30%, get out.');
    }

    let message = UIHelper.header('STRATEGY REPORT', '🪄');
    message += `Target: *${stats.name}*\n`;
    message += UIHelper.separator('HEAVY');

    message += `🧠 *Archetype:* ${strategyName}\n`;
    message += `⚠️ *Risk Level:* ${riskLevel}\n`;
    message += `🤖 *Recommended Action:* ${action}\n\n`;

    message += `*📝 Execution Plan:*\n`;
    advice.forEach(line => message += `${line}\n`);

    // Optional TP/SL optimization summary (30D)
    try {
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const signals = await prisma.signal.findMany({
        where: {
          ...(type === 'GROUP' ? { groupId: entityId } : { userId: entityId }),
          OR: [
            { entryPriceAt: { gte: since } },
            { entryPriceAt: null, detectedAt: { gte: since } }
          ],
          metrics: { isNot: null }
        },
        include: { metrics: true }
      });
      const optimized = optimizeTpSl(
        signals.map(s => ({
          id: s.id,
          mint: s.mint,
          entryPrice: s.entryPrice,
          entryMarketCap: s.entryMarketCap,
          detectedAt: s.detectedAt,
          metrics: s.metrics
            ? {
                athMultiple: s.metrics.athMultiple,
                timeToAth: s.metrics.timeToAth,
                maxDrawdown: s.metrics.maxDrawdown,
                drawdownDuration: s.metrics.drawdownDuration
              }
            : null
        })),
        { tps: [1.6, 2, 2.5, 3, 4, 5], sls: [0.5, 0.6, 0.7, 0.8] },
        {
          takeProfitRules: [],
          stopLossRules: [],
          stopOnFirstRuleHit: false,
          rulePriority: 'TP_FIRST',
          feePerSide: 0
        }
      );
      if (optimized) {
        message += `🎯 *Optimized TP/SL (30D):* TP ${optimized.takeProfitMultiple}x | SL ${optimized.stopLossMultiple}x\n`;
        message += `   Expected Return: ${(optimized.result.returnPct * 100).toFixed(1)}% | Max DD: ${optimized.result.maxDrawdown.toFixed(1)}%\n\n`;
      }
    } catch {}

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

