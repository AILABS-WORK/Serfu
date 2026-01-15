import { Context } from 'telegraf';
import { getTopStrategies, simulateCopyTrading, computeGroupStrategy, computeUserStrategy } from '../../analytics/copyTrading';
import { logger } from '../../utils/logger';
import { prisma } from '../../db';
import { getGroupByChatId } from '../../db/groups';
import { UIHelper } from '../../utils/ui';

export const handleStrategyMenu = async (ctx: Context) => {
  const message = UIHelper.header('STRATEGY MENU', '🧠') +
    `Pick an option:\n` +
    `• Create a new strategy\n` +
    `• View top strategy recommendations\n` +
    `• Manage saved presets\n` +
    `• Simulate a strategy\n` +
    `• Auto-generate a strategy\n`;

  await ctx.reply(message, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '🧪 Create Strategy', callback_data: 'strategy_create' }],
        [{ text: '📈 View Top Strategies', callback_data: 'strategy_view_existing' }],
        [{ text: '🗂️ Manage Presets', callback_data: 'strategy_presets' }],
        [{ text: '🎮 Simulate Strategy', callback_data: 'strategy_simulate_help' }],
        [{ text: '🤖 Auto Strategy', callback_data: 'strategy_auto' }],
        [{ text: '🔙 Back', callback_data: 'analytics' }],
      ],
    },
  });
};

export const handleStrategyAutoMenu = async (ctx: Context) => {
  await ctx.reply('🤖 *Auto Strategy Builder*\nChoose a profile:', {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '🛡️ Max Win Rate', callback_data: 'strategy_auto:winrate' }],
        [{ text: '⚖️ Balanced', callback_data: 'strategy_auto:balanced' }],
        [{ text: '🚀 High Return', callback_data: 'strategy_auto:return' }],
        [{ text: '🔙 Strategy Menu', callback_data: 'strategy_menu' }],
      ],
    },
  });
};

export const handleStrategyAutoGenerate = async (ctx: Context, profile: 'winrate' | 'balanced' | 'return') => {
  const ownerTelegramId = ctx.from?.id ? BigInt(ctx.from.id) : null;
  if (!ownerTelegramId) return ctx.reply('❌ Unable to identify user.');
  const owner = await prisma.user.findUnique({ where: { userId: ownerTelegramId } });
  if (!owner) return ctx.reply('❌ User not found.');

  const groups = await prisma.group.findMany({
    where: { ownerId: owner.id, isActive: true },
    select: { id: true, name: true, chatId: true },
  });
  if (groups.length === 0) return ctx.reply('No groups available to analyze.');

  const { getGroupStats } = await import('../../analytics/aggregator');
  const statsList = await Promise.all(groups.map(async (g) => ({
    group: g,
    stats: await getGroupStats(g.id, '30D'),
  })));
  const valid = statsList.filter(s => s.stats && s.stats.totalSignals > 0) as Array<{ group: any; stats: any }>;
  if (valid.length === 0) return ctx.reply('No analytics data available to auto-generate a strategy.');

  const ranked = [...valid].sort((a, b) => {
    if (profile === 'winrate') return (b.stats.winRate - a.stats.winRate) || (b.stats.avgMultiple - a.stats.avgMultiple);
    if (profile === 'return') return (b.stats.avgMultiple - a.stats.avgMultiple) || (b.stats.winRate - a.stats.winRate);
    return (b.stats.score - a.stats.score) || (b.stats.winRate - a.stats.winRate);
  });
  const picks = ranked.slice(0, Math.min(3, ranked.length));

  const primary = picks[0];
  const avgMultiple = Math.max(1.2, primary.stats.avgMultiple || 1.2);
  const avgDrawdown = Math.max(0.1, primary.stats.avgDrawdown || 0.3);
  const recTp = profile === 'return'
    ? Math.min(10, Math.max(3, avgMultiple * 1.4))
    : profile === 'balanced'
      ? Math.min(8, Math.max(2.2, avgMultiple * 1.1))
      : Math.min(6, Math.max(1.8, avgMultiple * 0.9));
  const recSl = Math.max(0.55, Math.min(0.9, 1 - Math.min(0.5, avgDrawdown)));

  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dayGroups: Record<string, number[]> = {};
  dayNames.forEach((day, idx) => {
    const pick = picks[idx % picks.length];
    dayGroups[day] = pick ? [pick.group.id] : [];
  });

  const tpRules = profile === 'return'
    ? [
        { multiple: 3, sellPct: 40 },
        { multiple: 5, sellPct: 40 },
        { multiple: 8, sellPct: 20 },
      ]
    : profile === 'balanced'
      ? [
          { multiple: 2.5, sellPct: 50 },
          { multiple: 4, sellPct: 50 },
        ]
      : [
          { multiple: 2, sellPct: 50 },
          { multiple: 3, sellPct: 50 },
        ];

  const slRules = profile === 'return'
    ? [{ multiple: 0.6, sellPct: 100 }]
    : profile === 'balanced'
      ? [{ multiple: 0.65, sellPct: 100 }]
      : [{ multiple: 0.7, sellPct: 100 }];

  const avgEntry = primary.stats.avgEntryMarketCap || 0;
  const minMarketCap = avgEntry > 0
    ? (profile === 'return' ? Math.max(5000, avgEntry * 0.4) : Math.max(10000, avgEntry * 0.6))
    : undefined;
  const maxMarketCap = avgEntry > 0
    ? (profile === 'return' ? avgEntry * 1.3 : avgEntry * 2.2)
    : undefined;
  const minMentions = profile === 'winrate' ? 3 : profile === 'balanced' ? 2 : 1;
  const rulePriority = profile === 'winrate' ? 'SL_FIRST' : profile === 'return' ? 'TP_FIRST' : 'INTERLEAVED';

  if (!(ctx as any).session) (ctx as any).session = {};
  (ctx as any).session.strategyDraft = {
    targetType: 'OVERALL',
    targetId: undefined,
    targetName: `Auto Strategy (${profile})`,
    timeframe: '30D',
    schedule: { timezone: 'UTC', days: dayNames, windows: [], dayGroups },
    conditions: {
      minMentions,
      minMarketCap,
      maxMarketCap,
      takeProfitMultiple: recTp,
      stopLossMultiple: recSl,
      takeProfitRules: tpRules,
      stopLossRules: slRules,
      rulePriority,
      stopOnFirstRuleHit: false,
    },
    startBalanceSol: 1,
    feePerSideSol: 0.0001,
  };

  const groupSummary = picks
    .map((p, idx) => `${idx + 1}. ${p.group.name || p.group.chatId} (${(p.stats.winRate * 100).toFixed(0)}% WR, ${p.stats.avgMultiple.toFixed(1)}x)`)
    .join('\n');
  await ctx.reply(
    `✅ Auto strategy created (*${profile}*).\n\n*Day/Group Rotation:*\n${groupSummary}`,
    { parse_mode: 'Markdown' }
  );
  await handleStrategyDraftSummary(ctx);
};

export const handleStrategyTargetSelect = async (ctx: Context) => {
  if (!(ctx as any).session) (ctx as any).session = {};
  (ctx as any).session.strategyDraft = { targetType: undefined, targetId: undefined, timeframe: undefined };

  await ctx.editMessageText('🎯 *Select Strategy Target*', {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Overall', callback_data: 'strategy_target:OVERALL' }],
        [{ text: 'Group', callback_data: 'strategy_target:GROUP' }],
        [{ text: 'User', callback_data: 'strategy_target:USER' }],
        [{ text: '🔙 Back', callback_data: 'strategy_menu' }],
      ],
    },
  });
};

export const handleStrategyTargetList = async (ctx: Context, type: 'GROUP' | 'USER') => {
  const ownerTelegramId = ctx.from?.id ? BigInt(ctx.from.id) : null;
  if (!ownerTelegramId) return ctx.answerCbQuery('User not identified');

  if (type === 'GROUP') {
    const groups = await prisma.group.findMany({
      where: { owner: { userId: ownerTelegramId }, isActive: true },
      take: 10,
    });
    const buttons = groups.map(g => [{
      text: g.name || `Group ${g.chatId}`,
      callback_data: `strategy_target_group:${g.id}`
    }]);
    buttons.push([{ text: '🔙 Back', callback_data: 'strategy_create' }]);
    await ctx.editMessageText('👥 *Pick a Group*', {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: buttons }
    });
    return;
  }

  const recentSignals = await prisma.signal.findMany({
    where: { group: { owner: { userId: ownerTelegramId } }, userId: { not: null } },
    select: { userId: true },
    orderBy: { detectedAt: 'desc' },
    take: 50
  });
  const userIds = Array.from(new Set(recentSignals.map(s => s.userId!).filter(Boolean)));
  const users = await prisma.user.findMany({ where: { id: { in: userIds } }, take: 10 });
  const buttons = users.map(u => [{
    text: u.username ? `@${u.username}` : (u.firstName || `User ${u.id}`),
    callback_data: `strategy_target_user:${u.id}`
  }]);
  buttons.push([{ text: '🔙 Back', callback_data: 'strategy_create' }]);
  await ctx.editMessageText('👤 *Pick a User*', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: buttons }
  });
};

export const handleStrategyTimeframeSelect = async (ctx: Context) => {
  await ctx.editMessageText('⏱️ *Select Timeframe*', {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [
          { text: '1D', callback_data: 'strategy_time:1D' },
          { text: '7D', callback_data: 'strategy_time:7D' },
          { text: '30D', callback_data: 'strategy_time:30D' },
          { text: 'ALL', callback_data: 'strategy_time:ALL' },
          { text: 'Custom', callback_data: 'strategy_time:custom' },
        ],
        [{ text: '🔙 Back', callback_data: 'strategy_create' }],
      ],
    },
  });
};

export const handleStrategyDraftSummary = async (ctx: Context) => {
  const draft = (ctx as any).session?.strategyDraft || {};
  const targetType = draft.targetType || 'OVERALL';
  const timeframe = draft.timeframe || '30D';
  const startBalanceSol = draft.startBalanceSol ?? 1;
  const feePerSideSol = draft.feePerSideSol ?? 0.0001;
  let targetLabel = 'Overall';
  const schedule = draft.schedule || { days: [], windows: [], timezone: 'UTC', dayGroups: {} };
  const conditions = draft.conditions || {};
  const tp = conditions.takeProfitMultiple;
  const sl = conditions.stopLossMultiple;
  const tpRules = (conditions.takeProfitRules || []) as Array<{ multiple: number; maxMinutes?: number; sellPct?: number }>;
  const slRules = (conditions.stopLossRules || []) as Array<{ multiple: number; maxMinutes?: number; sellPct?: number }>;
  const rulePriority = conditions.rulePriority || 'TP_FIRST';
  const stopOnFirstRuleHit = conditions.stopOnFirstRuleHit ?? false;

  if (targetType === 'GROUP' && draft.targetId) {
    const group = await prisma.group.findUnique({ where: { id: draft.targetId } });
    if (group) targetLabel = group.name || `Group ${group.chatId}`;
  }
  if (targetType === 'USER' && draft.targetId) {
    const user = await prisma.user.findUnique({ where: { id: draft.targetId } });
    if (user) targetLabel = user.username ? `@${user.username}` : (user.firstName || `User ${user.id}`);
  }

  let message = UIHelper.header('STRATEGY SUMMARY', '🧪');
  message += `Target: *${targetLabel}*\n`;
  message += `Timeframe: *${timeframe}*\n`;
  message += `Start Balance: *${startBalanceSol} SOL* | Fee/Side: *${feePerSideSol} SOL*\n`;
  message += `Schedule: *${schedule.days?.length ? schedule.days.join(', ') : 'All days'}* | *${schedule.windows?.length ? schedule.windows.map((w: any) => `${w.start}-${w.end}`).join(', ') : 'All day'}* (UTC)\n`;
  if (schedule.dayGroups && Object.keys(schedule.dayGroups).length > 0) {
    const dayGroups = schedule.dayGroups as Record<string, number[]>;
    const allGroupIds = Array.from(new Set(Object.values(dayGroups).flat() as number[]));
    const groups = allGroupIds.length > 0
      ? await prisma.group.findMany({ where: { id: { in: allGroupIds } }, select: { id: true, name: true, chatId: true } })
      : [];
    const groupNameMap = new Map(groups.map(g => [g.id, g.name || `Group ${g.chatId}`]));
    const dayMap = Object.entries(dayGroups).map(([day, ids]) => {
      const names = (ids as number[]).map((id: number) => groupNameMap.get(id) || `Group ${id}`).join(', ');
      return `${day}: ${names || 'None'}`;
    }).join(' | ');
    message += `Day Groups: ${dayMap}\n`;
  }
  message += `Conditions: Min Vol ${conditions.minVolume ? UIHelper.formatMarketCap(conditions.minVolume) : 'Off'} | Min Mentions ${conditions.minMentions ?? 'Off'} | Min MC ${conditions.minMarketCap ? UIHelper.formatMarketCap(conditions.minMarketCap) : 'Off'} | Max MC ${conditions.maxMarketCap ? UIHelper.formatMarketCap(conditions.maxMarketCap) : 'Off'}\n`;
  message += `TP/SL: ${conditions.takeProfitMultiple ? `${conditions.takeProfitMultiple.toFixed(2)}x` : 'Off'} / ${conditions.stopLossMultiple ? `${conditions.stopLossMultiple.toFixed(2)}x` : 'Off'}\n`;
  message += `TP Rules: ${conditions.takeProfitRules?.length ? conditions.takeProfitRules.map((r: any) => `${r.multiple}x${r.sellPct ? ` ${Math.round(r.sellPct * 100)}%` : ''}${r.maxMinutes ? ` ${r.maxMinutes}m` : ''}`).join(', ') : 'Off'}\n`;
  message += `SL Rules: ${conditions.stopLossRules?.length ? conditions.stopLossRules.map((r: any) => `${r.multiple}x${r.sellPct ? ` ${Math.round(r.sellPct * 100)}%` : ''}${r.maxMinutes ? ` ${r.maxMinutes}m` : ''}`).join(', ') : 'Off'}\n`;
  message += `Rule Priority: *${rulePriority}* | Stop on First Hit: *${stopOnFirstRuleHit ? 'ON' : 'OFF'}*\n`;
  message += UIHelper.separator('LIGHT');

  if (targetType === 'OVERALL') {
    const strategies = await getTopStrategies(3, timeframe as any);
    if (strategies.length > 0) {
      message += `*Top Recommendations:*\n`;
      strategies.forEach((s, idx) => {
        message += `${idx + 1}. ${s.strategyType === 'group' ? '👥' : '👤'} *${s.targetName}* — ${(s.winRate * 100).toFixed(0)}% WR, ${s.expectedReturn.toFixed(2)}x\n`;
      });
    } else {
      message += `No recommendations available for this timeframe.\n`;
    }
  } else if (targetType === 'GROUP' && draft.targetId) {
    const strat = await computeGroupStrategy(draft.targetId, timeframe as any);
    if (strat) {
      message += `Recommendation: *${strat.recommendation}*\n`;
      message += `${strat.reasoning}\n`;
      message += `Win Rate: ${(strat.winRate * 100).toFixed(0)}% | Expected: ${strat.expectedReturn.toFixed(2)}x\n`;
    } else {
      message += `No strategy data available for this target/timeframe.\n`;
    }
    const { getGroupStats } = await import('../../analytics/aggregator');
    const stats = await getGroupStats(draft.targetId, timeframe as any);
    if (stats && stats.avgMultiple > 0) {
      const recTp = Math.min(5, Math.max(1.5, stats.avgMultiple * 0.7));
      const recSl = Math.min(0.9, Math.max(0.5, 1 + stats.avgDrawdown));
      message += `Suggested TP/SL: *${recTp.toFixed(2)}x* / *${recSl.toFixed(2)}x*\n`;
    }
  } else if (targetType === 'USER' && draft.targetId) {
    const strat = await computeUserStrategy(draft.targetId, timeframe as any);
    if (strat) {
      message += `Recommendation: *${strat.recommendation}*\n`;
      message += `${strat.reasoning}\n`;
      message += `Win Rate: ${(strat.winRate * 100).toFixed(0)}% | Expected: ${strat.expectedReturn.toFixed(2)}x\n`;
    } else {
      message += `No strategy data available for this target/timeframe.\n`;
    }
    const { getUserStats } = await import('../../analytics/aggregator');
    const stats = await getUserStats(draft.targetId, timeframe as any);
    if (stats && stats.avgMultiple > 0) {
      const recTp = Math.min(5, Math.max(1.5, stats.avgMultiple * 0.7));
      const recSl = Math.min(0.9, Math.max(0.5, 1 + stats.avgDrawdown));
      message += `Suggested TP/SL: *${recTp.toFixed(2)}x* / *${recSl.toFixed(2)}x*\n`;
    }
  }

  message += UIHelper.separator('LIGHT');
  message += `Use /simulate for a full backtest.\n`;

  await ctx.reply(message, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '💰 Set Balance', callback_data: 'strategy_set_balance' }],
        [{ text: '⚙️ Set Fees', callback_data: 'strategy_set_fees' }],
        [{ text: '🗓️ Schedule', callback_data: 'strategy_schedule' }],
        [{ text: '🧰 Conditions', callback_data: 'strategy_conditions' }],
        [{ text: '🧪 Backtest', callback_data: 'strategy_backtest' }],
        [{ text: '🔀 Rule Priority', callback_data: 'strategy_rule_priority' }],
        [{ text: stopOnFirstRuleHit ? '⛔ Stop First ON' : '▶️ Stop First OFF', callback_data: 'strategy_stop_first' }],
        [{ text: '💾 Save Preset', callback_data: 'strategy_save' }],
        [{ text: '📈 View Top Strategies', callback_data: 'strategy_view_existing' }],
        [{ text: '🔙 Strategy Menu', callback_data: 'strategy_menu' }],
      ],
    },
  });
};

export const handleStrategyScheduleView = async (ctx: Context) => {
  if (!(ctx as any).session.strategyDraft) (ctx as any).session.strategyDraft = {};
  if (!(ctx as any).session.strategyDraft.schedule) {
    (ctx as any).session.strategyDraft.schedule = { timezone: 'UTC', days: [], windows: [], dayGroups: {} };
  }
  const schedule = (ctx as any).session.strategyDraft.schedule;
  const days = schedule.days || [];
  const windows = schedule.windows || [];
  const dayGroups = schedule.dayGroups || {};

  let message = UIHelper.header('STRATEGY SCHEDULE', '🗓️');
  message += `Timezone: *${schedule.timezone || 'UTC'}*\n`;
  message += `Days: ${days.length > 0 ? days.join(', ') : 'All'}\n`;
  message += `Windows: ${windows.length > 0 ? windows.map((w: any) => `${w.start}-${w.end}`).join(', ') : 'All day'}\n`;
  const mapLines = Object.entries(dayGroups as Record<string, number[]>)
    .map(([day, ids]) => `${day}: ${(ids as number[]).length} group${(ids as number[]).length === 1 ? '' : 's'}`)
    .join(' | ');
  message += `Day Groups: ${mapLines || 'All groups'}\n`;

  const dayToggle = (day: string) => ({
    text: days.includes(day) ? `✅ ${day}` : day,
    callback_data: `strategy_day:${day}`
  });

  await ctx.reply(message, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [dayToggle('Mon'), dayToggle('Tue'), dayToggle('Wed'), dayToggle('Thu')],
        [dayToggle('Fri'), dayToggle('Sat'), dayToggle('Sun')],
        [{ text: '🧭 Assign Day → Groups', callback_data: 'strategy_day_groups' }],
        [{ text: '➕ Add Time Window', callback_data: 'strategy_add_window' }],
        [{ text: '🧹 Clear Windows', callback_data: 'strategy_clear_windows' }],
        [{ text: '🔙 Summary', callback_data: 'strategy_summary' }],
      ],
    },
  });
};

export const handleStrategyDayGroupSelect = async (ctx: Context) => {
  await ctx.reply('Select a day to assign groups:', {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Mon', callback_data: 'strategy_day_select:Mon' },
          { text: 'Tue', callback_data: 'strategy_day_select:Tue' },
          { text: 'Wed', callback_data: 'strategy_day_select:Wed' },
          { text: 'Thu', callback_data: 'strategy_day_select:Thu' }
        ],
        [
          { text: 'Fri', callback_data: 'strategy_day_select:Fri' },
          { text: 'Sat', callback_data: 'strategy_day_select:Sat' },
          { text: 'Sun', callback_data: 'strategy_day_select:Sun' }
        ],
        [{ text: '🔙 Schedule', callback_data: 'strategy_schedule' }]
      ]
    }
  });
};

export const handleStrategyDayGroupList = async (ctx: Context, day: string) => {
  const ownerTelegramId = ctx.from?.id ? BigInt(ctx.from.id) : null;
  if (!ownerTelegramId) return ctx.answerCbQuery('User not identified');
  const groups = await prisma.group.findMany({
    where: { owner: { userId: ownerTelegramId }, isActive: true },
    take: 10
  });
  if (!(ctx as any).session.strategyDraft) (ctx as any).session.strategyDraft = {};
  if (!(ctx as any).session.strategyDraft.schedule) {
    (ctx as any).session.strategyDraft.schedule = { timezone: 'UTC', days: [], windows: [], dayGroups: {} };
  }
  const schedule = (ctx as any).session.strategyDraft.schedule;
  if (!schedule.dayGroups) schedule.dayGroups = {};
  const assigned = schedule.dayGroups[day] || [];

  const buttons = groups.map(g => [{
    text: assigned.includes(g.id) ? `✅ ${g.name || g.chatId}` : (g.name || `Group ${g.chatId}`),
    callback_data: `strategy_day_group_toggle:${day}:${g.id}`
  }]);
  buttons.push([{ text: '🔙 Day Select', callback_data: 'strategy_day_groups' }]);
  buttons.push([{ text: '🧹 Clear Day Groups', callback_data: `strategy_day_group_clear:${day}` }]);

  await ctx.reply(`Assign groups for *${day}* (toggle):`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: buttons }
  });
};

export const handleStrategyConditionsView = async (ctx: Context) => {
  if (!(ctx as any).session.strategyDraft) (ctx as any).session.strategyDraft = {};
  if (!(ctx as any).session.strategyDraft.conditions) (ctx as any).session.strategyDraft.conditions = {};
  const c = (ctx as any).session.strategyDraft.conditions;
  const tpRules = c.takeProfitRules || [];
  const slRules = c.stopLossRules || [];

  let message = UIHelper.header('STRATEGY CONDITIONS', '🧰');
  message += `Min Volume: *${c.minVolume ? UIHelper.formatMarketCap(c.minVolume) : 'Off'}*\n`;
  message += `Min Mentions: *${c.minMentions ?? 'Off'}*\n`;
  message += `Min MC: *${c.minMarketCap ? UIHelper.formatMarketCap(c.minMarketCap) : 'Off'}*\n`;
  message += `Max MC: *${c.maxMarketCap ? UIHelper.formatMarketCap(c.maxMarketCap) : 'Off'}*\n`;
  message += `Take Profit: *${c.takeProfitMultiple ? `${c.takeProfitMultiple.toFixed(2)}x` : 'Off'}*\n`;
  message += `Stop Loss: *${c.stopLossMultiple ? `${c.stopLossMultiple.toFixed(2)}x` : 'Off'}*\n`;
  message += `TP Rules: *${tpRules.length > 0 ? tpRules.map((r: any) => `${r.multiple}x${r.sellPct ? ` ${Math.round(r.sellPct * 100)}%` : ''}${r.maxMinutes ? ` ${r.maxMinutes}m` : ''}`).join(', ') : 'Off'}*\n`;
  message += `SL Rules: *${slRules.length > 0 ? slRules.map((r: any) => `${r.multiple}x${r.sellPct ? ` ${Math.round(r.sellPct * 100)}%` : ''}${r.maxMinutes ? ` ${r.maxMinutes}m` : ''}`).join(', ') : 'Off'}*\n`;
  message += `Rule Priority: *${c.rulePriority || 'TP_FIRST'}* | Stop First: *${c.stopOnFirstRuleHit ? 'ON' : 'OFF'}*\n`;

  await ctx.reply(message, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Set Min Volume', callback_data: 'strategy_cond:volume' }],
        [{ text: 'Set Min Mentions', callback_data: 'strategy_cond:mentions' }],
        [{ text: 'Set Min MC', callback_data: 'strategy_cond:min_mc' }],
        [{ text: 'Set Max MC', callback_data: 'strategy_cond:max_mc' }],
        [{ text: 'Set Take Profit', callback_data: 'strategy_cond:tp' }],
        [{ text: 'Set Stop Loss', callback_data: 'strategy_cond:sl' }],
        [{ text: 'Add TP Rule', callback_data: 'strategy_cond:tp_rule' }],
        [{ text: 'Add SL Rule', callback_data: 'strategy_cond:sl_rule' }],
        [{ text: 'Clear TP Rules', callback_data: 'strategy_cond:tp_rule_clear' }],
        [{ text: 'Clear SL Rules', callback_data: 'strategy_cond:sl_rule_clear' }],
        [{ text: 'Clear Conditions', callback_data: 'strategy_cond:clear' }],
        [{ text: '🔙 Summary', callback_data: 'strategy_summary' }],
      ],
    },
  });
};

export const handleStrategySavePreset = async (ctx: Context) => {
  const draft = (ctx as any).session?.strategyDraft;
  if (!draft?.timeframe) {
    return ctx.reply('❌ Please select a timeframe first.');
  }
  if (!draft?.targetType) {
    return ctx.reply('❌ Please select a target first.');
  }
  const ownerTelegramId = ctx.from?.id ? BigInt(ctx.from.id) : null;
  if (!ownerTelegramId) return ctx.reply('❌ Unable to identify user.');
  const owner = await prisma.user.findUnique({ where: { userId: ownerTelegramId } });
  if (!owner) return ctx.reply('❌ User not found.');

  await prisma.strategyPreset.create({
    data: {
      ownerId: owner.id,
      targetType: draft.targetType,
      targetId: draft.targetId ?? null,
      timeframe: draft.timeframe,
      schedule: draft.schedule ?? {},
      conditions: {
        ...(draft.conditions ?? {}),
        takeProfitMultiple: draft.conditions?.takeProfitMultiple ?? null,
        stopLossMultiple: draft.conditions?.stopLossMultiple ?? null,
        takeProfitRules: draft.conditions?.takeProfitRules ?? [],
        stopLossRules: draft.conditions?.stopLossRules ?? [],
        rulePriority: draft.conditions?.rulePriority ?? 'TP_FIRST',
        stopOnFirstRuleHit: draft.conditions?.stopOnFirstRuleHit ?? false,
        startBalanceSol: draft.startBalanceSol ?? 1,
        feePerSideSol: draft.feePerSideSol ?? 0.0001,
      },
      isActive: true,
    }
  });

  await ctx.reply('✅ Strategy preset saved.');
};

export const handleStrategyPresetsList = async (ctx: Context) => {
  const ownerTelegramId = ctx.from?.id ? BigInt(ctx.from.id) : null;
  if (!ownerTelegramId) return ctx.reply('❌ Unable to identify user.');
  const owner = await prisma.user.findUnique({ where: { userId: ownerTelegramId } });
  if (!owner) return ctx.reply('❌ User not found.');

  const presets = await prisma.strategyPreset.findMany({
    where: { ownerId: owner.id },
    orderBy: { createdAt: 'desc' },
    take: 10
  });

  if (presets.length === 0) {
    return ctx.reply('No strategy presets saved yet.');
  }

  let message = UIHelper.header('STRATEGY PRESETS', '🗂️');
  presets.forEach((p, idx) => {
    const status = p.isActive ? '✅' : '❌';
    message += `${idx + 1}. ${status} *${p.targetType}* ${p.timeframe}\n`;
  });

  const keyboard = presets.flatMap(p => ([
    [
      { text: `View #${p.id}`, callback_data: `strategy_preset_view:${p.id}` },
      { text: `${p.isActive ? 'Disable' : 'Enable'} #${p.id}`, callback_data: `strategy_preset_toggle:${p.id}` },
      { text: `Delete #${p.id}`, callback_data: `strategy_preset_delete:${p.id}` },
    ],
    [
      { text: `Edit Days #${p.id}`, callback_data: `strategy_preset_days:${p.id}` },
    ]
  ]));
  presets.forEach(p => {
    keyboard.push([
      { text: `Add TP Rule #${p.id}`, callback_data: `strategy_preset_tp_rule_add:${p.id}` },
      { text: `Add SL Rule #${p.id}`, callback_data: `strategy_preset_sl_rule_add:${p.id}` },
    ]);
    keyboard.push([
      { text: `Clear TP Rules #${p.id}`, callback_data: `strategy_preset_tp_rule_clear:${p.id}` },
      { text: `Clear SL Rules #${p.id}`, callback_data: `strategy_preset_sl_rule_clear:${p.id}` },
    ]);
  });
  keyboard.push([{ text: '🔙 Strategy Menu', callback_data: 'strategy_menu' }]);

  await ctx.reply(message, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
};

export const handleStrategyPresetDetails = async (ctx: Context, presetId: number) => {
  const ownerTelegramId = ctx.from?.id ? BigInt(ctx.from.id) : null;
  if (!ownerTelegramId) return ctx.reply('❌ Unable to identify user.');
  const owner = await prisma.user.findUnique({ where: { userId: ownerTelegramId } });
  if (!owner) return ctx.reply('❌ User not found.');
  const preset = await prisma.strategyPreset.findFirst({ where: { id: presetId, ownerId: owner.id } });
  if (!preset) return ctx.reply('Preset not found.');

  const schedule: any = preset.schedule || {};
  const conditions: any = preset.conditions || {};
  const tpRules = conditions.takeProfitRules || [];
  const slRules = conditions.stopLossRules || [];

  let targetLabel = preset.targetType;
  if (preset.targetType === 'GROUP' && preset.targetId) {
    const group = await prisma.group.findUnique({ where: { id: preset.targetId } });
    if (group) targetLabel = `GROUP: ${group.name || group.chatId}`;
  }
  if (preset.targetType === 'USER' && preset.targetId) {
    const user = await prisma.user.findUnique({ where: { id: preset.targetId } });
    if (user) targetLabel = `USER: ${user.username ? `@${user.username}` : (user.firstName || user.id)}`;
  }

  let message = UIHelper.header('PRESET DETAILS', '🗂️');
  message += `ID: *${preset.id}* | Active: *${preset.isActive ? 'Yes' : 'No'}*\n`;
  message += `Target: *${targetLabel}*\n`;
  message += `Timeframe: *${preset.timeframe}*\n`;
  message += `Schedule Days: ${schedule.days?.length ? schedule.days.join(', ') : 'All'}\n`;
  message += `Windows: ${schedule.windows?.length ? schedule.windows.map((w: any) => `${w.start}-${w.end}`).join(', ') : 'All day'}\n`;
  if (schedule.dayGroups && Object.keys(schedule.dayGroups).length > 0) {
    const dayGroups = schedule.dayGroups as Record<string, number[]>;
    const allGroupIds = Array.from(new Set(Object.values(dayGroups).flat() as number[]));
    const groups = allGroupIds.length > 0
      ? await prisma.group.findMany({ where: { id: { in: allGroupIds } }, select: { id: true, name: true, chatId: true } })
      : [];
    const groupNameMap = new Map(groups.map(g => [g.id, g.name || `Group ${g.chatId}`]));
    const dayMap = Object.entries(dayGroups).map(([day, ids]) => {
      const names = (ids as number[]).map((id: number) => groupNameMap.get(id) || `Group ${id}`).join(', ');
      return `${day}: ${names || 'None'}`;
    }).join(' | ');
    message += `Day Groups: ${dayMap}\n`;
  }
  message += `Min Vol: ${conditions.minVolume ? UIHelper.formatMarketCap(conditions.minVolume) : 'Off'} | Min Mentions: ${conditions.minMentions ?? 'Off'}\n`;
  message += `Min MC: ${conditions.minMarketCap ? UIHelper.formatMarketCap(conditions.minMarketCap) : 'Off'} | Max MC: ${conditions.maxMarketCap ? UIHelper.formatMarketCap(conditions.maxMarketCap) : 'Off'}\n`;
  message += `TP/SL: ${conditions.takeProfitMultiple ? `${conditions.takeProfitMultiple.toFixed(2)}x` : 'Off'} / ${conditions.stopLossMultiple ? `${conditions.stopLossMultiple.toFixed(2)}x` : 'Off'}\n`;
  message += `Rule Priority: ${conditions.rulePriority || 'TP_FIRST'} | Stop First: ${conditions.stopOnFirstRuleHit ? 'ON' : 'OFF'}\n`;
  message += `TP Rules:\n`;
  if (tpRules.length === 0) message += `  - Off\n`;
  tpRules.forEach((r: any, idx: number) => {
    message += `  ${idx}. ${r.multiple}x${r.sellPct ? ` ${Math.round(r.sellPct * 100)}%` : ''}${r.maxMinutes ? ` ${r.maxMinutes}m` : ''}\n`;
  });
  message += `SL Rules:\n`;
  if (slRules.length === 0) message += `  - Off\n`;
  slRules.forEach((r: any, idx: number) => {
    message += `  ${idx}. ${r.multiple}x${r.sellPct ? ` ${Math.round(r.sellPct * 100)}%` : ''}${r.maxMinutes ? ` ${r.maxMinutes}m` : ''}\n`;
  });

  const keyboard: any[] = [];
  tpRules.slice(0, 5).forEach((_: any, idx: number) => {
    keyboard.push([{ text: `Delete TP #${idx}`, callback_data: `strategy_preset_tp_rule_del:${preset.id}:${idx}` }]);
  });
  slRules.slice(0, 5).forEach((_: any, idx: number) => {
    keyboard.push([{ text: `Delete SL #${idx}`, callback_data: `strategy_preset_sl_rule_del:${preset.id}:${idx}` }]);
  });
  keyboard.push([{ text: '🔙 Presets', callback_data: 'strategy_presets' }]);

  await ctx.reply(message, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
};

export const handleStrategyPresetDaySelect = async (ctx: Context, presetId: number) => {
  await ctx.reply('Select a day to assign groups:', {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Mon', callback_data: `strategy_preset_day_select:${presetId}:Mon` },
          { text: 'Tue', callback_data: `strategy_preset_day_select:${presetId}:Tue` },
          { text: 'Wed', callback_data: `strategy_preset_day_select:${presetId}:Wed` },
          { text: 'Thu', callback_data: `strategy_preset_day_select:${presetId}:Thu` }
        ],
        [
          { text: 'Fri', callback_data: `strategy_preset_day_select:${presetId}:Fri` },
          { text: 'Sat', callback_data: `strategy_preset_day_select:${presetId}:Sat` },
          { text: 'Sun', callback_data: `strategy_preset_day_select:${presetId}:Sun` }
        ],
        [{ text: '🔙 Presets', callback_data: 'strategy_presets' }]
      ]
    }
  });
};

export const handleStrategyPresetDayGroupList = async (ctx: Context, presetId: number, day: string) => {
  const ownerTelegramId = ctx.from?.id ? BigInt(ctx.from.id) : null;
  if (!ownerTelegramId) return ctx.answerCbQuery('User not identified');
  const owner = await prisma.user.findUnique({ where: { userId: ownerTelegramId } });
  if (!owner) return ctx.answerCbQuery('User not found');

  const preset = await prisma.strategyPreset.findFirst({ where: { id: presetId, ownerId: owner.id } });
  if (!preset) return ctx.reply('Preset not found.');
  const schedule: any = preset.schedule || {};
  if (!schedule.dayGroups) schedule.dayGroups = {};
  const assigned: number[] = schedule.dayGroups[day] || [];

  const groups = await prisma.group.findMany({
    where: { ownerId: owner.id, isActive: true },
    take: 10
  });
  const buttons = groups.map(g => [{
    text: assigned.includes(g.id) ? `✅ ${g.name || g.chatId}` : (g.name || `Group ${g.chatId}`),
    callback_data: `strategy_preset_day_group_toggle:${presetId}:${day}:${g.id}`
  }]);
  buttons.push([{ text: '🔙 Day Select', callback_data: `strategy_preset_days:${presetId}` }]);
  buttons.push([{ text: '🧹 Clear Day Groups', callback_data: `strategy_preset_day_group_clear:${presetId}:${day}` }]);

  await ctx.reply(`Assign groups for *${day}* (toggle):`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: buttons }
  });
};

const withinSchedule = (date: Date, schedule: any): boolean => {
  const days = schedule?.days || [];
  const windows = schedule?.windows || [];
  const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const day = dayNames[date.getUTCDay()];
  if (days.length > 0 && !days.includes(day)) return false;
  if (!windows || windows.length === 0) return true;
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  return windows.some((w: any) => {
    const [sh, sm] = w.start.split(':').map((x: string) => parseInt(x, 10));
    const [eh, em] = w.end.split(':').map((x: string) => parseInt(x, 10));
    const start = sh * 60 + sm;
    const end = eh * 60 + em;
    if (start <= end) return minutes >= start && minutes <= end;
    return minutes >= start || minutes <= end; // overnight window
  });
};

export const handleStrategyBacktest = async (ctx: Context) => {
  const draft = (ctx as any).session?.strategyDraft;
  if (!draft?.timeframe) return ctx.reply('❌ Please set a timeframe first.');
  if (!draft?.targetType) return ctx.reply('❌ Please set a target first.');

  const ownerTelegramId = ctx.from?.id ? BigInt(ctx.from.id) : null;
  if (!ownerTelegramId) return ctx.reply('❌ Unable to identify user.');

  const startBalanceSol = draft.startBalanceSol ?? 1;
  const feePerSideSol = draft.feePerSideSol ?? 0.0001;
  const totalFee = feePerSideSol * 2;
  const schedule = draft.schedule || { days: [], windows: [], timezone: 'UTC', dayGroups: {} };
  const conditions = draft.conditions || {};
  const tp = conditions.takeProfitMultiple;
  const sl = conditions.stopLossMultiple;
  const tpRules = (conditions.takeProfitRules || []) as Array<{ multiple: number; maxMinutes?: number; sellPct?: number }>;
  const slRules = (conditions.stopLossRules || []) as Array<{ multiple: number; maxMinutes?: number; sellPct?: number }>;
  const rulePriority = conditions.rulePriority || 'TP_FIRST';
  const stopOnFirstRuleHit = conditions.stopOnFirstRuleHit ?? false;

  const timeframe = draft.timeframe as string;
  const since = UIHelper.parseTimeframeInput(timeframe) ? new Date(Date.now() - UIHelper.parseTimeframeInput(timeframe)!.ms) : null;

  // Scope signals
  const ownerGroups = await prisma.group.findMany({
    where: { owner: { userId: ownerTelegramId }, isActive: true },
    select: { id: true, chatId: true, type: true }
  });
  const ownedChatIds = ownerGroups.map(g => g.chatId);
  const destinationGroupIds = ownerGroups.filter(g => g.type === 'destination').map(g => g.id);
  let forwardedSignalIds: number[] = [];
  if (destinationGroupIds.length > 0) {
    const forwarded = await prisma.forwardedSignal.findMany({
      where: { destGroupId: { in: destinationGroupIds.map(id => BigInt(id)) } },
      select: { signalId: true }
    });
    forwardedSignalIds = forwarded.map(f => f.signalId);
  }

  let scope: any = {};
  if (draft.targetType === 'GROUP' && draft.targetId) {
    scope = { groupId: draft.targetId };
  } else if (draft.targetType === 'USER' && draft.targetId) {
    scope = { userId: draft.targetId };
  } else {
    scope = {
      OR: [
        { chatId: { in: ownedChatIds } },
        { id: { in: forwardedSignalIds } }
      ]
    };
  }

  const signals = await prisma.signal.findMany({
    where: {
      ...(since ? { detectedAt: { gte: since } } : {}),
      metrics: { isNot: null },
      ...scope
    },
    include: { metrics: true, priceSamples: { orderBy: { sampledAt: 'asc' }, take: 1 } },
    orderBy: { detectedAt: 'asc' }
  });

  if (signals.length === 0) {
    return ctx.reply('No signals found for this timeframe/target.');
  }

  // Mentions count (approx): total calls per mint in scope
  const mintCounts = new Map<string, number>();
  signals.forEach(s => mintCounts.set(s.mint, (mintCounts.get(s.mint) || 0) + 1));

  const filtered = signals.filter(s => {
    if (!s.entryMarketCap) return false;
    if (!s.metrics?.athMultiple) return false;
    if (!withinSchedule(s.detectedAt, schedule)) return false;
    if (schedule.dayGroups && Object.keys(schedule.dayGroups).length > 0) {
      const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
      const day = dayNames[s.detectedAt.getUTCDay()];
      const allowed = schedule.dayGroups[day] || [];
      if (allowed.length > 0 && s.groupId && !allowed.includes(s.groupId)) return false;
    }
    if (conditions.minMarketCap && s.entryMarketCap < conditions.minMarketCap) return false;
    if (conditions.maxMarketCap && s.entryMarketCap > conditions.maxMarketCap) return false;
    if (conditions.minVolume) {
      const vol = s.priceSamples?.[0]?.volume || 0;
      if (vol < conditions.minVolume) return false;
    }
    if (conditions.minMentions) {
      const mentions = mintCounts.get(s.mint) || 0;
      if (mentions < conditions.minMentions) return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    return ctx.reply('No signals match your strategy conditions.');
  }

  const perTrade = startBalanceSol / filtered.length;
  let balance = startBalanceSol;
  let wins = 0;
  let roiSum = 0;
  let multSum = 0;
  let timeSum = 0;
  let timeCount = 0;
  let peak = startBalanceSol;
  let maxDrawdown = 0;

  for (const s of filtered) {
    const mult = s.metrics?.athMultiple || 0;
    multSum += mult;
    let remaining = 1;
    let realizedMultiple = 0;
    const timeToAthMin = s.metrics?.timeToAth ? s.metrics.timeToAth / (1000 * 60) : undefined;
    const minMultiple = s.metrics?.maxDrawdown ? 1 + s.metrics.maxDrawdown : 1;
    const slDurationMin = s.metrics?.drawdownDuration ? s.metrics.drawdownDuration / (1000 * 60) : undefined;
    const applyRule = (rule: any, isTp: boolean): boolean => {
      if (remaining <= 0) return true;
      const hit = isTp ? mult >= rule.multiple : minMultiple <= rule.multiple;
      const window = isTp ? timeToAthMin : slDurationMin;
      const timeOk = !rule.maxMinutes || (window !== undefined && window <= rule.maxMinutes);
      if (hit && timeOk) {
        const pct = rule.sellPct ?? 1;
        const sell = Math.min(remaining, pct);
        realizedMultiple += sell * rule.multiple;
        remaining -= sell;
        if (stopOnFirstRuleHit) {
          realizedMultiple += remaining * rule.multiple;
          remaining = 0;
          return true;
        }
      }
      return false;
    };

    const sortedTp = [...tpRules].sort((a, b) => a.multiple - b.multiple);
    const sortedSl = [...slRules].sort((a, b) => a.multiple - b.multiple);
    if (rulePriority === 'TP_FIRST') {
      for (const rule of sortedTp) {
        if (applyRule(rule, true)) break;
      }
      for (const rule of sortedSl) {
        if (applyRule(rule, false)) break;
      }
    } else if (rulePriority === 'SL_FIRST') {
      for (const rule of sortedSl) {
        if (applyRule(rule, false)) break;
      }
      for (const rule of sortedTp) {
        if (applyRule(rule, true)) break;
      }
    } else {
      const combined = [
        ...sortedTp.map(r => ({ ...r, isTp: true })),
        ...sortedSl.map(r => ({ ...r, isTp: false }))
      ].sort((a, b) => a.multiple - b.multiple);
      for (const rule of combined) {
        if (applyRule(rule, rule.isTp)) break;
      }
    }
    if (remaining > 0 && sl && minMultiple <= sl) {
      realizedMultiple += remaining * sl;
      remaining = 0;
    }
    if (remaining > 0 && tp && mult >= tp) {
      realizedMultiple += remaining * tp;
      remaining = 0;
    }
    if (remaining > 0) {
      realizedMultiple += remaining * mult;
      remaining = 0;
    }

    const gross = perTrade * realizedMultiple;
    const net = gross - totalFee;
    const roi = perTrade > 0 ? (net - perTrade) / perTrade : 0;
    roiSum += roi;
    if (realizedMultiple >= 2) wins++;
    balance += net - perTrade;
    if (balance > peak) peak = balance;
    const dd = peak > 0 ? (peak - balance) / peak : 0;
    if (dd > maxDrawdown) maxDrawdown = dd;
    if (s.metrics?.timeToAth) {
      timeSum += s.metrics.timeToAth / (1000 * 60);
      timeCount++;
    }
  }

  const avgRoi = roiSum / filtered.length;
  const avgMult = multSum / filtered.length;
  const winRate = wins / filtered.length;
  const avgHold = timeCount ? timeSum / timeCount : 0;
  const returnPct = (balance - startBalanceSol) / startBalanceSol;

  let message = UIHelper.header('STRATEGY BACKTEST', '🧪');
  message += `Trades: *${filtered.length}*\n`;
  message += `Win Rate: *${(winRate * 100).toFixed(1)}%*\n`;
  message += `Avg Multiple: *${avgMult.toFixed(2)}x*\n`;
  message += `Avg ROI/Trade: *${(avgRoi * 100).toFixed(1)}%*\n`;
  message += `Avg Hold Time: *${UIHelper.formatDurationMinutes(avgHold)}*\n`;
  message += `Max Drawdown: *${(maxDrawdown * 100).toFixed(1)}%*\n`;
  message += UIHelper.separator('LIGHT');
  message += `Start Balance: *${startBalanceSol} SOL*\n`;
  message += `End Balance: *${balance.toFixed(4)} SOL* (${(returnPct * 100).toFixed(1)}%)\n`;
  message += `Fee/Side: *${feePerSideSol} SOL* (Total/Trade: ${totalFee} SOL)\n`;
  message += `_Assumptions: exit at TP/SL rules, then TP/SL, otherwise ATH multiple; SL timing uses drawdown duration when available._\n`;

  await ctx.reply(message, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔧 Adjust Strategy', callback_data: 'strategy_summary' }],
        [{ text: '🧪 Re-run Backtest', callback_data: 'strategy_backtest' }],
      ]
    }
  });
};

export const handleCopyTradingCommand = async (ctx: Context, window: '7D' | '30D' | 'ALL' = '30D') => {
  try {
    const strategies = await getTopStrategies(10, window);

    if (strategies.length === 0) {
      return ctx.reply(`No strategies available for ${window} window. Need more signal data.`);
    }

    let message = `📈 *Top Copy Trading Strategies (${window})*\n\n`;

    strategies.slice(0, 5).forEach((strategy, index) => {
      const rank = index + 1;
      const emoji = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `${rank}.`;
      const typeEmoji = strategy.strategyType === 'user' ? '👤' : '👥';
      const recEmoji = strategy.recommendation === 'STRONG_BUY' ? '🟢' : 
                      strategy.recommendation === 'BUY' ? '🟡' : 
                      strategy.recommendation === 'NEUTRAL' ? '🟠' : '🔴';

      message += `${emoji} ${typeEmoji} *${strategy.targetName}*\n`;
      message += `   ${recEmoji} ${strategy.recommendation}\n`;
      message += `   Win Rate: ${(strategy.winRate * 100).toFixed(1)}%\n`;
      message += `   Expected Return: ${strategy.expectedReturn.toFixed(2)}x\n`;
      message += `   Consistency: ${(strategy.consistencyScore * 100).toFixed(1)}%\n\n`;
    });

    await ctx.reply(message, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '7D', callback_data: `copytrade:7D` },
            { text: '30D', callback_data: `copytrade:30D` },
            { text: 'ALL', callback_data: `copytrade:ALL` },
          ],
          [
            { text: '🔙 Back', callback_data: 'analytics_copytrade' },
          ],
        ],
      },
    });
  } catch (error) {
    logger.error('Error in copy trading command:', error);
    ctx.reply('Error loading copy trading strategies.');
  }
};

export const handleSimulateCommand = async (
  ctx: Context,
  strategyType: 'user' | 'group',
  targetIdStr: string,
  capital: number = 1000
) => {
  try {
    let targetId: number;
    let targetName: string;

    if (strategyType === 'user') {
      const user = await prisma.user.findUnique({
        where: { userId: BigInt(targetIdStr) },
      });
      if (!user) {
        return ctx.reply('User not found.');
      }
      targetId = user.id;
      targetName = user.username || user.firstName || user.userId.toString();
    } else {
      const userId = ctx.from?.id ? BigInt(ctx.from.id) : null;
      if (!userId) {
        return ctx.reply('❌ Unable to identify user.');
      }
      const group = await getGroupByChatId(BigInt(targetIdStr), userId);
      if (!group) {
        return ctx.reply('❌ Group not found. Make sure you own this group.');
      }
      targetId = group.id;
      targetName = group.name || group.chatId.toString();
    }

    const simulation = await simulateCopyTrading(strategyType, targetId, '30D', capital);

    const message = `
💰 *Copy Trading Simulation*

*Target:* ${strategyType === 'user' ? '👤' : '👥'} ${targetName}
*Window:* Last 30 Days
*Initial Capital:* ${simulation.initialCapital.toFixed(4)} SOL

*Results:*
Final Value: ${simulation.finalValue.toFixed(4)} SOL
Total Return: ${simulation.totalReturn.toFixed(4)} SOL
Return: ${simulation.returnPercent > 0 ? '+' : ''}${simulation.returnPercent.toFixed(2)}%

*Signals Followed:* ${simulation.signalsFollowed}
*Wins:* ${simulation.wins}
*Losses:* ${simulation.losses}
    `;

    await ctx.reply(message, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '📊 View Strategy', callback_data: `${strategyType}_strategy:${targetId}` },
          ],
        ],
      },
    });
  } catch (error) {
    logger.error('Error in simulate command:', error);
    ctx.reply('Error running simulation.');
  }
};



