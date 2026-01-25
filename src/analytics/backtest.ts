export type RulePriority = 'TP_FIRST' | 'SL_FIRST' | 'EARLIEST';

export interface BacktestRule {
  multiple: number;
  maxMinutes?: number;
  sellPct?: number;
}

export interface BacktestOptions {
  takeProfitMultiple?: number;
  stopLossMultiple?: number;
  takeProfitRules?: BacktestRule[];
  stopLossRules?: BacktestRule[];
  stopOnFirstRuleHit?: boolean;
  rulePriority?: RulePriority;
  feePerSide?: number;
  perTradeAmount: number;
}

export interface BacktestSignalInput {
  id: number;
  mint: string;
  entryPrice?: number | null;
  entryMarketCap?: number | null;
  detectedAt: Date;
  metrics?: {
    athMultiple?: number | null;
    timeToAth?: number | null;
    maxDrawdown?: number | null; // percent
    drawdownDuration?: number | null;
  } | null;
}

export interface BacktestResult {
  trades: number;
  wins: number;
  avgMultiple: number;
  avgRoi: number;
  avgHoldMinutes: number;
  maxDrawdown: number; // percent
  startBalance: number;
  endBalance: number;
  returnPct: number;
}

const applyRules = (
  mult: number,
  minMultiple: number,
  timeToAthMin: number | undefined,
  slDurationMin: number | undefined,
  options: BacktestOptions
): number => {
  let remaining = 1;
  let realizedMultiple = 0;
  const tp = options.takeProfitMultiple;
  const sl = options.stopLossMultiple;
  const tpRules = options.takeProfitRules || [];
  const slRules = options.stopLossRules || [];
  const stopOnFirstRuleHit = !!options.stopOnFirstRuleHit;
  const rulePriority = options.rulePriority || 'TP_FIRST';

  const applyRule = (rule: BacktestRule, isTp: boolean): boolean => {
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
    for (const rule of sortedTp) if (applyRule(rule, true)) break;
    for (const rule of sortedSl) if (applyRule(rule, false)) break;
  } else if (rulePriority === 'SL_FIRST') {
    for (const rule of sortedSl) if (applyRule(rule, false)) break;
    for (const rule of sortedTp) if (applyRule(rule, true)) break;
  } else {
    const combined = [
      ...sortedTp.map(r => ({ ...r, isTp: true })),
      ...sortedSl.map(r => ({ ...r, isTp: false }))
    ].sort((a, b) => a.multiple - b.multiple);
    for (const rule of combined) if (applyRule(rule, rule.isTp)) break;
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

  return realizedMultiple;
};

export const runBacktest = (signals: BacktestSignalInput[], options: BacktestOptions): BacktestResult => {
  const perTrade = options.perTradeAmount;
  const feePerSide = options.feePerSide ?? 0;
  const totalFee = feePerSide * 2;

  let balance = perTrade * signals.length;
  let wins = 0;
  let roiSum = 0;
  let multSum = 0;
  let timeSum = 0;
  let timeCount = 0;
  let peak = balance;
  let maxDrawdown = 0;

  for (const s of signals) {
    const mult = s.metrics?.athMultiple || 0;
    multSum += mult;
    const timeToAthMin = s.metrics?.timeToAth ? s.metrics.timeToAth / (1000 * 60) : undefined;
    const minMultiple = s.metrics?.maxDrawdown !== undefined && s.metrics?.maxDrawdown !== null
      ? 1 + (s.metrics.maxDrawdown / 100)
      : 1;
    const slDurationMin = s.metrics?.drawdownDuration ? s.metrics.drawdownDuration / (1000 * 60) : undefined;

    const realizedMultiple = applyRules(mult, minMultiple, timeToAthMin, slDurationMin, options);
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

  const avgRoi = roiSum / signals.length;
  const avgMult = multSum / signals.length;
  const avgHold = timeCount ? timeSum / timeCount : 0;
  const startBalance = perTrade * signals.length;
  const returnPct = startBalance > 0 ? (balance - startBalance) / startBalance : 0;

  return {
    trades: signals.length,
    wins,
    avgMultiple: avgMult,
    avgRoi,
    avgHoldMinutes: avgHold,
    maxDrawdown: maxDrawdown * 100,
    startBalance,
    endBalance: balance,
    returnPct
  };
};

