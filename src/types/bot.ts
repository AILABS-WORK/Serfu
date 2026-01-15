import { Context } from 'telegraf';

export interface SessionData {
  liveFilters?: {
    minMult?: number;
    onlyGainers?: boolean;
  };
  distributions?: {
    timeframe?: string;
    targetType?: 'OVERALL' | 'GROUP' | 'USER';
    targetId?: number;
    lastChatId?: number;
    lastMessageId?: number;
  };
  leaderboards?: {
    group?: string;
    user?: string;
    signal?: string;
  };
  recent?: {
    timeframe?: string;
  };
  stats?: {
    group?: Record<number, string>;
    user?: Record<number, string>;
  };
  strategyDraft?: {
    targetType?: 'OVERALL' | 'GROUP' | 'USER';
    targetId?: number;
    timeframe?: string;
    startBalanceSol?: number;
    feePerSideSol?: number;
    schedule?: {
      days?: string[];
      windows?: Array<{ start: string; end: string }>;
      timezone?: string;
      dayGroups?: Record<string, number[]>;
    };
    conditions?: {
      minVolume?: number;
      minMentions?: number;
      minMarketCap?: number;
      maxMarketCap?: number;
      takeProfitMultiple?: number;
      stopLossMultiple?: number;
      takeProfitRules?: Array<{ multiple: number; maxMinutes?: number; sellPct?: number }>;
      stopLossRules?: Array<{ multiple: number; maxMinutes?: number; sellPct?: number }>;
      rulePriority?: 'TP_FIRST' | 'SL_FIRST' | 'INTERLEAVED';
      stopOnFirstRuleHit?: boolean;
    };
  };
  strategyPresets?: Array<{
    targetType: 'OVERALL' | 'GROUP' | 'USER';
    targetId?: number;
    timeframe: string;
    createdAt: number;
  }>;
  strategyEditPresetId?: number;
  pendingInput?: {
    type:
      | 'dist_timeframe'
      | 'leaderboard_groups'
      | 'leaderboard_users'
      | 'leaderboard_signals'
      | 'recent_timeframe'
      | 'group_stats_timeframe'
      | 'user_stats_timeframe'
      | 'strategy_timeframe'
      | 'strategy_time_window'
      | 'strategy_cond_volume'
      | 'strategy_cond_mentions'
      | 'strategy_cond_min_mc'
      | 'strategy_cond_max_mc'
      | 'strategy_cond_tp'
      | 'strategy_cond_sl'
      | 'strategy_cond_tp_rule'
      | 'strategy_cond_sl_rule'
      | 'preset_tp_rule'
      | 'preset_sl_rule'
      | 'strategy_balance'
      | 'strategy_fee';
    groupId?: number;
    userId?: number;
    day?: string;
    presetId?: number;
  };
}

export interface BotContext extends Context {
  session: SessionData;
}
