import { Telegraf, Context } from 'telegraf';
import { prisma } from '../db';
import { renderChart } from '../charts/renderer';
import { logger } from '../utils/logger';

export const registerActions = (bot: Telegraf) => {
  bot.action(/^chart:(\d+)$/, async (ctx) => {
    const signalId = parseInt(ctx.match[1]);
    try {
      await ctx.answerCbQuery('Generating chart...');
      
      const signal = await prisma.signal.findUnique({
        where: { id: signalId },
        include: { priceSamples: true }
      });

      if (!signal) {
        return ctx.reply('Signal not found.');
      }

      if (signal.priceSamples.length === 0) {
        return ctx.reply('No price data available yet.');
      }

      const imageBuffer = await renderChart(signal, signal.priceSamples);
      
      await ctx.replyWithPhoto({ source: imageBuffer }, {
        caption: `Chart for ${signal.name || signal.mint}`
      });
      
    } catch (error) {
      logger.error('Error generating chart:', error);
      ctx.reply('Failed to generate chart.');
    }
  });

  bot.action(/^stats:(\d+)$/, async (ctx) => {
    const signalId = parseInt(ctx.match[1]);
    try {
      const signal = await prisma.signal.findUnique({
        where: { id: signalId },
        include: { metrics: true }
      });
      
      if (!signal || !signal.metrics) {
        return ctx.answerCbQuery('No stats available.');
      }

      const m = signal.metrics;
      const text = `
📊 *Stats for ${signal.name}*

Current: $${m.currentPrice.toFixed(6)} (${m.currentMultiple.toFixed(2)}x)
ATH: $${m.athPrice.toFixed(6)} (${m.athMultiple.toFixed(2)}x)
Drawdown: ${(m.maxDrawdown * 100).toFixed(2)}%
Entry: $${signal.entryPrice?.toFixed(6)}
      `;

      await ctx.answerCbQuery();
      await ctx.reply(text, { parse_mode: 'Markdown' });

    } catch (error) {
       logger.error('Error showing stats:', error);
    }
  });
};

