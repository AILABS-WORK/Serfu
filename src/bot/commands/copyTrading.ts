import { Context } from 'telegraf';
import { getTopStrategies, simulateCopyTrading, computeGroupStrategy, computeUserStrategy } from '../../analytics/copyTrading';
import { logger } from '../../utils/logger';
import { prisma } from '../../db';

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
      const group = await prisma.group.findUnique({
        where: { chatId: BigInt(targetIdStr) },
      });
      if (!group) {
        return ctx.reply('Group not found.');
      }
      targetId = group.id;
      targetName = group.name || group.chatId.toString();
    }

    const simulation = await simulateCopyTrading(strategyType, targetId, '30D', capital);

    const message = `
💰 *Copy Trading Simulation*

*Target:* ${strategyType === 'user' ? '👤' : '👥'} ${targetName}
*Window:* Last 30 Days
*Initial Capital:* $${simulation.initialCapital.toFixed(2)}

*Results:*
Final Value: $${simulation.finalValue.toFixed(2)}
Total Return: $${simulation.totalReturn.toFixed(2)}
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

