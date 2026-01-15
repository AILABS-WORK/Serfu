import { Context } from 'telegraf';
import { prisma } from '../../db';
import { logger } from '../../utils/logger';
import { UIHelper } from '../../utils/ui';
import { getMultipleTokenPrices } from '../../providers/jupiter';

export const handleWatchlistCommand = async (ctx: Context) => {
  try {
    if (!ctx.from?.id) return ctx.reply('User not identified.');
    const user = await prisma.user.findUnique({ where: { userId: BigInt(ctx.from.id) } });
    if (!user) return ctx.reply('User profile not found.');

    const items = await prisma.watchlist.findMany({
        where: { userId: user.id },
        include: { signal: true }
    });

    if (items.length === 0) {
        return ctx.reply('⭐ *Watchlist*\nYour watchlist is empty.\nAdd tokens from signal cards.', { parse_mode: 'Markdown' });
    }

    const loading = await ctx.reply('⏳ Loading watchlist data...');

    // Batch fetch prices
    const mints = items.map(i => i.signal.mint);
    const prices = await getMultipleTokenPrices(mints);

    let message = UIHelper.header('Watchlist', '⭐');
    
    for (const item of items) {
        const s = item.signal;
        const current = prices[s.mint] || 0;
        const entryMc = s.entryMarketCap || 0;
        const currentMc = s.entrySupply && current ? current * s.entrySupply : 0;
        
        let pnlStr = '--';
        let icon = '⚪';
        
        if (currentMc > 0 && entryMc > 0) {
            const pnl = ((currentMc - entryMc) / entryMc) * 100;
            pnlStr = UIHelper.formatPercent(pnl);
            icon = pnl >= 0 ? '🟢' : '🔴';
        }

        const symbol = s.symbol || 'UNKNOWN';
        const entryStr = entryMc ? UIHelper.formatMarketCap(entryMc) : 'N/A';
        const currStr = currentMc ? UIHelper.formatMarketCap(currentMc) : 'N/A';

        message += `${icon} *${symbol}*\n`;
        message += `   Entry MC: ${entryStr} ➔ Now MC: ${currStr} | PnL: \`${pnlStr}\`\n`;
        message += `   \`${s.mint}\`\n`;
        message += `   [🗑 Remove](callback:remove_watchlist:${item.id})\n`; // This is pseudocode for button, but we can't put buttons inline easily in text list.
        message += UIHelper.separator('LIGHT');
    }

    // Interactive buttons for removing?
    // It's cleaner to have a "Manage" menu or just list them. 
    // Let's rely on signal cards to manage usually, or provide a "Clear All" or specific remove commands if needed.
    // For now, basic list.

    await ctx.telegram.editMessageText(loading.chat.id, loading.message_id, undefined, message, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [[{ text: '❌ Close', callback_data: 'delete_msg' }]]
        }
    });

  } catch (error) {
    logger.error('Error loading watchlist:', error);
    ctx.reply('Error loading watchlist.');
  }
};

export const handleAddToWatchlist = async (ctx: Context, signalId: number) => {
    try {
        if (!ctx.from?.id) return;
        const user = await prisma.user.findUnique({ where: { userId: BigInt(ctx.from.id) } });
        if (!user) {
            // Auto-create user if missing (should exist by now though)
            return ctx.answerCbQuery('User profile error.');
        }

        const signal = await prisma.signal.findUnique({ where: { id: signalId } });
        if (!signal) return ctx.answerCbQuery('Signal not found.');

        // Upsert
        await prisma.watchlist.upsert({
            where: {
                userId_signalId: {
                    userId: user.id,
                    signalId: signal.id
                }
            },
            create: {
                userId: user.id,
                signalId: signal.id
            },
            update: {}
        });

        await ctx.answerCbQuery(`⭐ Added ${signal.symbol} to Watchlist`);
    } catch (error) {
        logger.error('Error adding to watchlist:', error);
        ctx.answerCbQuery('Error adding to watchlist');
    }
};

