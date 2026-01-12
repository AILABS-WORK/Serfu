import { Telegraf } from 'telegraf';

let botInstance: Telegraf<any> | null = null;

export const setBotInstance = (bot: Telegraf<any>) => {
  botInstance = bot;
};

export const getBotInstance = () => {
  if (!botInstance) {
    throw new Error('Bot instance not initialized');
  }
  return botInstance;
};










