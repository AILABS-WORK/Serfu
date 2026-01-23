import { Context } from 'telegraf';
import { prisma } from '../../../db';
import { logger } from '../../../utils/logger';
import { UIHelper } from '../../../utils/ui';

export const handleDistributions = async (ctx: Context, view: string = 'mcap') => {
  try {
    const ownerTelegramId = ctx.from?.id ? BigInt(ctx.from.id) : null;
    if (!ownerTelegramId) return ctx.reply('❌ Unable to identify user.');

    const { getDistributionStats } = await import('../../../analytics/aggregator');
    let loadingMsg: any = null;
    if (!(ctx as any).session) (ctx as any).session = {};
    const session = (ctx as any).session;
    if (!session.distributions) {
      session.distributions = { timeframe: '30D', targetType: 'OVERALL', chain: 'both' };
    }
    const timeframe = session.distributions.timeframe || '30D';
    const targetType = session.distributions.targetType || 'OVERALL';
    const targetId = session.distributions.targetId;
    const chain = session.distributions.chain || 'both';
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

    if (ctx.callbackQuery && ctx.callbackQuery.message) {
      loadingMsg = ctx.callbackQuery.message;
      try {
        await ctx.telegram.editMessageText(
          loadingMsg.chat.id,
          loadingMsg.message_id,
          undefined,
          '⏳ Loading distributions...'
        );
      } catch {}
    } else {
      loadingMsg = await ctx.reply('⏳ Loading distributions...');
    }

    const stats = await getDistributionStats(ownerTelegramId, timeframe, { type: targetType, id: targetId }, chain);

    if (stats.totalSignals === 0) {
      const emptyMessage = 'No data available for distributions yet.';
      if (loadingMsg?.chat && loadingMsg?.message_id) {
        return ctx.telegram.editMessageText(
          loadingMsg.chat.id,
          loadingMsg.message_id,
          undefined,
          emptyMessage,
          { reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'analytics' }]] } }
        );
      }
      return ctx.reply(emptyMessage, {
        reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'analytics' }]] }
      });
    }

    let message = '';
    let keyboard: any[] = [];

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

      const bestBucket = stats.mcBuckets.reduce((prev: any, curr: any) => {
        const currWR = curr.count > 0 ? curr.wins / curr.count : 0;
        const prevWR = prev.count > 0 ? prev.wins / prev.count : 0;
        return currWR > prevWR ? curr : prev;
      });
      if (bestBucket.count > 0) {
        const wr = (bestBucket.wins / bestBucket.count) * 100;
        message += UIHelper.separator('HEAVY');
        message += `💡 *BEST RANGE (Win Rate):* ${bestBucket.label.trim()} (${wr.toFixed(0)}% WR)\n`;
      }

      const chainRow = [
        { text: chain === 'both' ? '✅ Both' : 'Both', callback_data: 'dist_chain:both' },
        { text: chain === 'solana' ? '✅ SOL' : 'SOL', callback_data: 'dist_chain:solana' },
        { text: chain === 'bsc' ? '✅ BSC' : 'BSC', callback_data: 'dist_chain:bsc' }
      ];

      keyboard = [
        [{ text: `🎯 Target: ${targetType === 'OVERALL' ? 'Overall' : targetType === 'GROUP' ? 'Group' : 'User'}`, callback_data: 'dist_target' }],
        chainRow,
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
    } else if (view === 'time') {
      message = UIHelper.header('TIME OF DAY (UTC)', '🕐');
      message += `Timezone: *UTC*\n`;
      const bestHours = stats.timeOfDay
        .map((h: any, i: number) => ({ hourNum: i, count: h.count, winRate: h.winRate, avgMult: h.avgMult }))
        .filter((h: any) => h.count > 0)
        .sort((a: any, b: any) => b.winRate - a.winRate)
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
      stats.timeOfDay.forEach((h: any, i: number) => {
        const hour = i.toString().padStart(2, '0');
        const wr = h.count > 0 ? (h.winRate * 100).toFixed(0).padStart(3, ' ') : '  -';
        const avg = h.count > 0 ? h.avgMult.toFixed(1).padStart(3, ' ') : ' - ';
        const calls = `${h.count}`.padStart(4, ' ');
        const heat = h.count === 0 ? '░' : h.winRate >= 0.65 ? '▮▮▮' : h.winRate >= 0.5 ? '▮▮' : h.winRate >= 0.35 ? '▮' : '░';
        message += `\`${hour}  | ${wr}% | ${avg} | ${calls} | ${heat}\`\n`;
      });
      keyboard = [[{ text: '🔙 MCap View', callback_data: 'dist_view:mcap' }, { text: '❌ Close', callback_data: 'delete_msg' }]];
    } else if (view === 'day') {
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
          { text: 'Thu', callback_data: 'dist_view:day_hour:Thu' }
        ],
        [
          { text: 'Fri', callback_data: 'dist_view:day_hour:Fri' },
          { text: 'Sat', callback_data: 'dist_view:day_hour:Sat' },
          { text: 'Sun', callback_data: 'dist_view:day_hour:Sun' }
        ],
        [{ text: '🔙 MCap View', callback_data: 'dist_view:mcap' }, { text: '❌ Close', callback_data: 'delete_msg' }]
      ];
    } else if (view.startsWith('day_hour:')) {
      const day = view.split(':')[1];
      const entry = stats.timeOfDayByDay.find((d: any) => d.day === day);
      message = UIHelper.header(`HOURLY BY ${day}`, '🕒');
      if (!entry) {
        message += `No data for ${day}.\n`;
      } else {
        const best = [...entry.hours]
          .filter((h: any) => h.count > 0)
          .sort((a: any, b: any) => b.winRate - a.winRate)[0];
        if (best) {
          message += `Best Hour: *${best.hour.toString().padStart(2, '0')}:00* — ${(best.winRate * 100).toFixed(0)}% WR (${best.count} calls)\n`;
          message += UIHelper.separator('LIGHT');
        }
        message += `\`Hour | WR  | Avg | Calls | Heat\`\n`;
        message += `\`─────┼─────┼─────┼──────┼────\`\n`;
        entry.hours.forEach((h: any) => {
          const hour = h.hour.toString().padStart(2, '0');
          const wr = h.count > 0 ? (h.winRate * 100).toFixed(0).padStart(3, ' ') : '  -';
          const avg = h.count > 0 ? h.avgMult.toFixed(1).padStart(3, ' ') : ' - ';
          const calls = `${h.count}`.padStart(4, ' ');
          const heat = h.count === 0 ? '░' : h.winRate >= 0.65 ? '▮▮▮' : h.winRate >= 0.5 ? '▮▮' : h.winRate >= 0.35 ? '▮' : '░';
          message += `\`${hour}  | ${wr}% | ${avg} | ${calls} | ${heat}\`\n`;
        });
      }
      keyboard = [[{ text: '🔙 Day of Week', callback_data: 'dist_view:day' }, { text: '❌ Close', callback_data: 'delete_msg' }]];
    } else if (view === 'groups') {
      message = UIHelper.header('GROUP WIN RATE COMPARISON', '👥');
      const topGroups = stats.groupWinRates.slice(0, 10);
      for (const g of topGroups) {
        message += `*${g.groupName}:* ${(g.winRate * 100).toFixed(0)}% WR | ${g.avgMult.toFixed(1)}x | ${g.count} calls\n`;
        message += `   Avg Entry MC: ${UIHelper.formatMarketCap(g.avgEntryMc)} | Avg ATH: ${g.avgAthMult.toFixed(1)}x\n`;
        message += `   Avg Time to ATH: ${UIHelper.formatDurationMinutes(g.avgTimeToAth)} | Moon Rate: ${(g.moonRate * 100).toFixed(0)}%\n`;
      }
      keyboard = [[{ text: '🔙 MCap View', callback_data: 'dist_view:mcap' }, { text: '❌ Close', callback_data: 'delete_msg' }]];
    } else if (view === 'volume') {
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
    } else if (view === 'rug') {
      message = UIHelper.header('RUG PULL ANALYSIS', '💀');
      message += `*Rug Pull Ratio:* ${(stats.rugPullRatio * 100).toFixed(1)}%\n`;
      message += `(${Math.round(stats.rugPullRatio * stats.totalSignals)} of ${stats.totalSignals} signals)\n\n`;
      message += `*Definition:* ATH < 0.5x OR Drawdown > 90%\n`;
      message += `_Time constraint not applied (no time-to-rug data yet)._`;
      keyboard = [[{ text: '🔙 MCap View', callback_data: 'dist_view:mcap' }, { text: '❌ Close', callback_data: 'delete_msg' }]];
    } else if (view === 'moonshot') {
      message = UIHelper.header('MOONSHOT PROBABILITY', '🚀');
      message += `\`Multiple | Count  | %\`\n`;
      message += `\`─────────┼────────┼─────\`\n`;
      const buckets = [
        { label: '>2x', count: stats.moonshotCounts.gt2x },
        { label: '>3x', count: stats.moonshotCounts.gt3x },
        { label: '>4x', count: stats.moonshotCounts.gt4x },
        { label: '>5x', count: stats.moonshotCounts.gt5x },
        { label: '>10x', count: stats.moonshotCounts.gt10x },
        { label: '>15x', count: stats.moonshotCounts.gt15x },
        { label: '>20x', count: stats.moonshotCounts.gt20x },
        { label: '>50x', count: stats.moonshotCounts.gt50x },
        { label: '>100x', count: stats.moonshotCounts.gt100x }
      ];

      for (const bucket of buckets) {
        const pct = stats.totalSignals ? (bucket.count / stats.totalSignals) * 100 : 0;
        const label = bucket.label.padEnd(7, ' ');
        const countStr = `${bucket.count}`.padStart(6, ' ');
        const pctStr = `${pct.toFixed(1)}%`.padStart(4, ' ');
        message += `\`${label} | ${countStr} | ${pctStr}\`\n`;
      }

      message += `\n⏱️ Avg Time to 2x/5x/10x: ${UIHelper.formatDurationMinutes(stats.moonshotTimes.timeTo2x)} / ${UIHelper.formatDurationMinutes(stats.moonshotTimes.timeTo5x)} / ${UIHelper.formatDurationMinutes(stats.moonshotTimes.timeTo10x)}\n`;
      keyboard = [[{ text: '🔙 MCap View', callback_data: 'dist_view:mcap' }, { text: '❌ Close', callback_data: 'delete_msg' }]];
    } else if (view === 'streak') {
      message = UIHelper.header('STREAK ANALYSIS', '🔥');
      message += `*After Losses:* 1L ${(stats.streakAnalysis.after1Loss.winRate * 100).toFixed(0)}% (${stats.streakAnalysis.after1Loss.count}) | 2L ${(stats.streakAnalysis.after2Losses.winRate * 100).toFixed(0)}% (${stats.streakAnalysis.after2Losses.count}) | 3L ${(stats.streakAnalysis.after3Losses.winRate * 100).toFixed(0)}% (${stats.streakAnalysis.after3Losses.count})\n`;
      message += `*After Wins:* 1W ${(stats.streakAnalysis.after1Win.winRate * 100).toFixed(0)}% (${stats.streakAnalysis.after1Win.count}) | 2W ${(stats.streakAnalysis.after2Wins.winRate * 100).toFixed(0)}% (${stats.streakAnalysis.after2Wins.count}) | 3W ${(stats.streakAnalysis.after3Wins.winRate * 100).toFixed(0)}% (${stats.streakAnalysis.after3Wins.count})\n\n`;
      message += `*Current Streak:* ${stats.currentStreak.count} ${stats.currentStreak.type === 'win' ? 'wins' : 'losses'}\n`;
      keyboard = [[{ text: '🔙 MCap View', callback_data: 'dist_view:mcap' }, { text: '❌ Close', callback_data: 'delete_msg' }]];
    } else if (view === 'age') {
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
    } else if (view === 'liquidity') {
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

    if (loadingMsg?.chat && loadingMsg?.message_id) {
      await ctx.telegram.editMessageText(loadingMsg.chat.id, loadingMsg.message_id, undefined, message, {
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
    logger.error('Error loading distributions:', error);
    try {
      await ctx.reply('Error loading distributions.');
    } catch {}
  }
};

