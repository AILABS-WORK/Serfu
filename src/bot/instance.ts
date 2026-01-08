import { Telegraf } from 'telegraf';

let botInstance: Telegraf | null = null;

export const setBotInstance = (bot: Telegraf) => {
  botInstance = bot;
};

export const getBotInstance = () => {
  if (!botInstance) {
    throw new Error('Bot instance not initialized');
  }
  return botInstance;
};


