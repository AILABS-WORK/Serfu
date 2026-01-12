import { Context } from 'telegraf';

export interface SessionData {
  liveFilters?: {
    minMult?: number;
    onlyGainers?: boolean;
  };
}

export interface BotContext extends Context {
  session: SessionData;
}
