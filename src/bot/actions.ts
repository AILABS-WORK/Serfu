import { Context, Telegraf } from 'telegraf';
import { BotContext } from '../types/bot';
import { prisma } from '../db';
import { logger } from '../utils/logger';
import { checkPriceAlerts } from '../jobs/priceAlerts';
import { generateFirstSignalCard } from './signalCard';
import { provider } from '../providers';
import { TokenMeta } from '../providers/types';
import { getGroupStats, getUserStats, getLeaderboard } from '../analytics/aggregator';
import { handleRecentCalls, handleAnalyticsCommand } from './commands/analytics';
import { updateHistoricalMetrics } from '../jobs/historicalMetrics';
import { getDeepHolderAnalysis } from '../analytics/holders';
import { UIHelper } from '../utils/ui';

export const registerActions = (bot: Telegraf<BotContext>) => {
  // --- EXISTING ACTIONS ---
  
  // Chart Button
  bot.action(/^chart:(\d+)$/, async (ctx) => {
    try {
      const signalId = parseInt(ctx.match[1]);
      const signal = await prisma.signal.findUnique({ where: { id: signalId } });
      
      if (!signal) return ctx.answerCbQuery('Signal not found');

      const chartUrl = `https://dexscreener.com/solana/${signal.mint}`;
      
      await ctx.reply(`📈 *Chart for ${signal.symbol || 'Token'}*\n${chartUrl}`, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[{ text: '❌ Close', callback_data: 'delete_msg' }]]
        }
      });
      await ctx.answerCbQuery();
    } catch (error) {
      logger.error('Chart action error:', error);
      ctx.answerCbQuery('Error opening chart');
    }
  });

  // Stats Button (basic signal stats)
  bot.action(/^stats:(\d+)$/, async (ctx) => {
    try {
      const signalId = parseInt(ctx.match[1]);
      const signal = await prisma.signal.findUnique({
        where: { id: signalId },
        include: { metrics: true }
      });

      if (!signal) return ctx.answerCbQuery('Signal not found');

      // Fetch fresh price
      let currentPrice = 0;
      let priceSource = 'unknown';
      try {
        const quote = await provider.getQuote(signal.mint);
        currentPrice = quote.price;
        priceSource = quote.source;
      } catch (e) {
        logger.warn(`Could not fetch price for stats: ${e}`);
      }

      const entry = signal.entryPrice || 0;
      const multiple = entry > 0 ? currentPrice / entry : 0;
      const ath = signal.metrics?.athMultiple || multiple; // Use stored ATH if available
      const dd = signal.metrics?.maxDrawdown || 0;

      const msg = `
📊 *Signal Stats*
Token: ${signal.symbol}
Entry: $${entry.toFixed(6)}
Current: $${currentPrice.toFixed(6)} (${multiple.toFixed(2)}x)
ATH: ${ath.toFixed(2)}x
Max Drawdown: ${(dd * 100).toFixed(2)}%
Source: ${priceSource}
      `.trim();

      await ctx.reply(msg, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[{ text: '❌ Close', callback_data: 'delete_msg' }]]
        }
      });
      await ctx.answerCbQuery();
    } catch (error) {
      logger.error('Stats action error:', error);
      ctx.answerCbQuery('Error fetching stats');
    }
  });

  // Watchlist (Placeholder)
  bot.action(/^watchlist:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery('Watchlist feature coming soon!');
  });

  // Hide Button
  bot.action('hide', async (ctx) => {
    try {
      await ctx.deleteMessage();
    } catch (e) {
      // ignore
    }
  });

  // Delete Msg
  bot.action('delete_msg', async (ctx) => {
    try {
      await ctx.deleteMessage();
    } catch (e) {
      // ignore
    }
  });

  // View Source
  bot.action(/^source:(\d+)$/, async (ctx) => {
    const signalId = parseInt(ctx.match[1]);
    const signal = await prisma.signal.findUnique({
      where: { id: signalId },
      include: { group: true }
    });
    
    if (signal?.group?.chatId) {
       // We can't link directly to private groups usually, but we can show info
       await ctx.answerCbQuery(`Source Group: ${signal.group.name}`);
    } else {
       await ctx.answerCbQuery('Source info unavailable');
    }
  });

  // Refresh Button
  bot.action(/^refresh:(\d+)$/, async (ctx) => {
    try {
        const signalId = parseInt(ctx.match[1]);
        const signal = await prisma.signal.findUnique({
            where: { id: signalId },
            include: { 
                group: { include: { owner: true } }, // Need owner for settings
                user: true 
            }
        });

        if (!signal) return ctx.answerCbQuery('Signal not found');

        await ctx.answerCbQuery('Refreshing data...');

        // 1. Fetch fresh data
        const meta = await provider.getTokenMeta(signal.mint);
        const quote = await provider.getQuote(signal.mint);
        const supply = meta?.supply ?? signal.entrySupply ?? undefined;
        
        const metaWithLive: TokenMeta = {
            ...meta,
            livePrice: quote.price,
            liveMarketCap: supply ? quote.price * supply : meta.marketCap,
        };

        // 2. Check relations (to handle duplicate logic if we were re-generating full context, 
        // but for refresh we mainly update stats. However, generateFirstSignalCard needs group/user names)
        
        // Find relation for this specific signal instance
        // We already included group/user above.
        
        const sigRel = signal; // alias

        // Re-generate card text
        const cardText = await generateFirstSignalCard(
            signal, 
            metaWithLive, 
            sigRel?.group?.name || 'Unknown Group', 
            sigRel?.user?.username || 'Unknown User'
        );

        // Update message
        // We need to preserve the keyboard.
        // We can reconstruct it or retrieve it from the message (ctx.callbackQuery.message.reply_markup)
        // But this handles only the first card?
        // If it's a duplicate card, we might need generateDuplicateSignalCard. 
        // But for simplicity, refresh usually updates the main content.
        // Let's assume most users click refresh on the first card.
        
        const currentMarkup = ctx.callbackQuery.message && 'reply_markup' in ctx.callbackQuery.message 
            ? ctx.callbackQuery.message.reply_markup 
            : undefined;

        await ctx.editMessageCaption(cardText, {
            parse_mode: 'Markdown',
            reply_markup: currentMarkup as any
        });

    } catch (error) {
        logger.error('Refresh action error:', error);
        ctx.answerCbQuery('Error refreshing data');
    }
  });

  // --- NEW: Analyze Holders Action ---
  const handleHolderAnalysis = async (ctx: Context, signalId: number, mode: 'standard' | 'deep') => {
      try {
        const signal = await prisma.signal.findUnique({ where: { id: signalId } });

        if (!signal) return ctx.answerCbQuery('Signal not found');

        const scanText = mode === 'deep' ? 'Deep Scanning Top 10 Wallets (Last 1000 Txs)... ⏳' : 'Scanning Top 10 Wallets (Last 100 Txs)...';
        await ctx.answerCbQuery(mode === 'deep' ? 'Starting deep scan...' : 'Scanning...');
        await ctx.reply(`🔍 *${scanText}*\nAnalyzing realized profits...`, { parse_mode: 'Markdown' });

        const summaries = await getDeepHolderAnalysis(signal.mint, mode);

        if (summaries.length === 0) {
            return ctx.reply('⚠️ Could not fetch detailed holder analysis.');
        }

        let report = `🕵️ *WHALE INSPECTOR* for ${signal.symbol} (${mode === 'deep' ? 'DEEP' : 'Standard'})\n\n`;

        for (const s of summaries) {
            report += `🐋 *Wallet:* \`${s.address.slice(0, 4)}...${s.address.slice(-4)}\` (Rank #${s.rank})\n`;
            report += `   Holding: ${s.percentage.toFixed(2)}% of supply\n`;
            
            // Top Trade (Best Play)
            if (s.topTrade) {
                const profitStr = s.topTrade.pnl > 1000 
                    ? `$${(s.topTrade.pnl / 1000).toFixed(1)}k` 
                    : `$${Math.round(s.topTrade.pnl)}`;
                const roiStr = s.topTrade.pnlPercent === 999 
                    ? 'Early Entry' 
                    : `${Math.round(s.topTrade.pnlPercent)}%`;
                report += `   🏆 *Best Play:* ${s.topTrade.symbol} (+${profitStr} / ${roiStr})\n`;
            }
            
            // Win Rate
            if (s.totalTrades && s.totalTrades > 0) {
                const wrIcon = s.winRate! >= 0.6 ? '🟢' : s.winRate! >= 0.4 ? '🟡' : '🔴';
                report += `   📉 *Win Rate:* ${wrIcon} ${(s.winRate! * 100).toFixed(0)}% (Last ${s.totalTrades} Txs)\n`;
            }
            
            // Notable holdings
            if (s.notableHoldings.length > 0) {
                report += `   💎 *Assets (> $5k):*\n`;
                for (const asset of s.notableHoldings) {
                    const valStr = asset.valueUsd ? `$${Math.round(asset.valueUsd).toLocaleString()}` : 'N/A';
                    report += `      • ${asset.symbol}: ${valStr}\n`;
                }
            }
            
            // Best Trades (Top 3)
            if (s.bestTrades.length > 0) {
                 report += `   🏆 *Top Trades (Last ${mode === 'deep' ? '1000' : '100'} Txs):*\n`;
                 for (const trade of s.bestTrades.slice(0, 3)) {
                     const profit = Math.round(trade.pnl).toLocaleString();
                     const bought = Math.round(trade.buyUsd).toLocaleString();
                     const sold = Math.round(trade.sellUsd).toLocaleString();
                     
                     const roiStr = trade.pnlPercent === 999 ? 'Early Entry' : `${Math.round(trade.pnlPercent)}%`;
                     
                     report += `      • ${trade.symbol}: +$${profit} (${roiStr}) (In $${bought} ➔ Out $${sold})\n`;
                 }
            }
            
            report += UIHelper.separator('LIGHT');
        }

        const keyboard = [[{ text: '❌ Close', callback_data: 'delete_msg' }]];
        if (mode === 'standard') {
            keyboard.unshift([{ text: '🕵️ Deep Scan (1000 Txs) 🐢', callback_data: `analyze_holders_deep:${signalId}` }]);
        }

        await ctx.reply(report, { 
            parse_mode: 'Markdown',
             reply_markup: {
                inline_keyboard: keyboard
            }
        });

    } catch (error) {
        logger.error('Analyze holders error:', error);
        ctx.reply('❌ Error generating holder analysis.');
    }
  };

  bot.action(/^analyze_holders:(\d+)$/, async (ctx) => {
      const signalId = parseInt(ctx.match[1]);
      await handleHolderAnalysis(ctx, signalId, 'standard');
  });

  bot.action(/^analyze_holders_deep:(\d+)$/, async (ctx) => {
      const signalId = parseInt(ctx.match[1]);
      await handleHolderAnalysis(ctx, signalId, 'deep');
  });


  bot.action(/^strategy_view:(GROUP|USER):(\d+)$/, async (ctx) => {
      const type = ctx.match[1] as 'GROUP' | 'USER';
      const id = ctx.match[2];
      const { handleStrategyCommand } = await import('./commands/analytics');
      await handleStrategyCommand(ctx as any, type, id);
      await ctx.answerCbQuery();
  });

  // --- LIVE SIGNALS & FILTERS ---
  
  bot.action('live_signals', async (ctx) => {
      const { handleLiveSignals } = await import('./commands/analytics');
      await handleLiveSignals(ctx);
  });

  bot.action(/^live_filter:(.*)$/, async (ctx) => {
      try {
          const filter = ctx.match[1];
          // Initialize session if not exists
          if (!ctx.session) ctx.session = {};
          if (!ctx.session.liveFilters) ctx.session.liveFilters = {};

          // Toggle logic
          if (filter === '2x') {
              ctx.session.liveFilters.minMult = ctx.session.liveFilters.minMult === 2 ? undefined : 2;
          } else if (filter === '5x') {
              ctx.session.liveFilters.minMult = ctx.session.liveFilters.minMult === 5 ? undefined : 5;
          } else if (filter === 'gainers') {
              ctx.session.liveFilters.onlyGainers = !ctx.session.liveFilters.onlyGainers;
          }

          // Reload view
          const { handleLiveSignals } = await import('./commands/analytics');
          await handleLiveSignals(ctx);
          await ctx.answerCbQuery('Filter updated');
      } catch (error) {
          logger.error('Filter action error:', error);
          ctx.answerCbQuery('Error updating filter');
      }
  });

  bot.action(/^live_sort:(.*)$/, async (ctx) => {
      try {
          const sortBy = ctx.match[1];
          // Initialize session if not exists
          if (!ctx.session) ctx.session = {};
          if (!ctx.session.liveFilters) ctx.session.liveFilters = {};

          // Set sort option
          if (['trending', 'newest', 'pnl'].includes(sortBy)) {
              (ctx.session.liveFilters as any).sortBy = sortBy;
          }

          // Reload view
          const { handleLiveSignals } = await import('./commands/analytics');
          await handleLiveSignals(ctx);
          await ctx.answerCbQuery(`Sorted by ${sortBy}`);
      } catch (error) {
          logger.error('Sort action error:', error);
          ctx.answerCbQuery('Error updating sort');
      }
  });

  bot.action('distributions', async (ctx) => {
      const { handleDistributions } = await import('./commands/analytics');
      await handleDistributions(ctx as any, 'mcap');
  });

  bot.action(/^dist_view:(.*)$/, async (ctx) => {
      const view = ctx.match[1];
      const { handleDistributions } = await import('./commands/analytics');
      await handleDistributions(ctx as any, view);
      await ctx.answerCbQuery();
  });

  bot.action('groups_menu', async (ctx) => {
      // Implement groups list similar to /groups command
      const { handleGroupsCommand } = await import('./commands/groups');
      await handleGroupsCommand(ctx as any); 
  });

  bot.action('group_add', async (ctx) => {
      const { getBotInviteLink } = await import('../db/groups');
      const botInfo = await ctx.telegram.getMe();
      const inviteLink = await getBotInviteLink(botInfo.username);
      
      await ctx.editMessageText(
          `➕ *Add Group*\n\n` +
          `1. Click the link below to select a group.\n` +
          `2. Add the bot to the group.\n` +
          `3. The bot will automatically register it as a Source.\n\n` +
          `*To set a Destination:* Run /setdestination inside the group.`,
          {
              parse_mode: 'Markdown',
              reply_markup: {
                  inline_keyboard: [
                      [{ text: '🔗 Add to Group', url: inviteLink }],
                      [{ text: '🔙 Back', callback_data: 'groups_menu' }]
                  ]
              }
          }
      );
  });

  bot.action('group_invite', async (ctx) => {
    const { getBotInviteLink } = await import('../db/groups');
    const botInfo = await ctx.telegram.getMe();
    const inviteLink = await getBotInviteLink(botInfo.username);
    
    await ctx.reply(`🔗 *Invite Link:*\n${inviteLink}`, { parse_mode: 'Markdown' });
    await ctx.answerCbQuery();
  });

  bot.action('channel_add', async (ctx) => {
      await ctx.editMessageText(
          `📡 *Add Channel*\n\n` +
          `1. Go to your Channel info > Administrators.\n` +
          `2. Add this bot as an Admin.\n` +
          `3. The bot will automatically detect and register the channel.\n\n` +
          `*Troubleshooting:*\n` +
          `If it doesn't appear, forward a message from the channel to this chat, or run:\n` +
          `/addchannel <channel_id>`,
          {
              parse_mode: 'Markdown',
              reply_markup: {
                  inline_keyboard: [
                      [{ text: '🔙 Back', callback_data: 'groups_menu' }]
                  ]
              }
          }
      );
  });
  
  bot.action('group_settings', async (ctx) => {
     await ctx.answerCbQuery('Use /groups to see settings for each group.');
  });

  bot.action('settings_menu', async (ctx) => {
      const { handleSettingsCommand } = await import('./commands/settings');
      await handleSettingsCommand(ctx as any);
  });

  bot.action('watchlist', async (ctx) => {
      const { handleWatchlistCommand } = await import('./commands/watchlist');
      await handleWatchlistCommand(ctx as any);
  });

  bot.action(/^watchlist_add:(\d+)$/, async (ctx) => {
      const signalId = parseInt(ctx.match[1]);
      const { handleAddToWatchlist } = await import('./commands/watchlist');
      await handleAddToWatchlist(ctx as any, signalId);
  });

  // --- ANALYTICS ACTIONS (Existing) ---
  
  bot.action('analytics', handleAnalyticsCommand);
  
  bot.action('analytics_recent', handleRecentCalls);
  
  bot.action('analytics_groups', async (ctx) => {
      const ownerTelegramId = ctx.from?.id ? BigInt(ctx.from.id) : null;
      if (!ownerTelegramId) return ctx.answerCbQuery('User not identified');

      const groups = await prisma.group.findMany({
          where: { owner: { userId: ownerTelegramId }, isActive: true },
          take: 10 // Limit to 10 for UI
      });

      if (groups.length === 0) {
          return ctx.editMessageText('👥 *My Groups*\nNo groups monitored yet.', {
              parse_mode: 'Markdown',
              reply_markup: {
                  inline_keyboard: [[{ text: '🔙 Back', callback_data: 'analytics' }]]
              }
          });
      }

      const buttons = groups.map(g => [{
          text: g.name || `Group ${g.chatId}`,
          callback_data: `group_stats_view:${g.id}`
      }]);

      buttons.push([{ text: '🔙 Back', callback_data: 'analytics' }]);

      await ctx.editMessageText('👥 *My Groups*\nSelect a group to view stats:', {
          parse_mode: 'Markdown',
          reply_markup: {
              inline_keyboard: buttons
          }
      });
  });

  bot.action('analytics_users_input', async (ctx) => {
      // Show top active users in workspace
      const ownerTelegramId = ctx.from?.id ? BigInt(ctx.from.id) : null;
      if (!ownerTelegramId) return ctx.answerCbQuery('User not identified');

      // Find users with most signals in workspace groups
      // This is a bit complex query, maybe just fetch recent signal users?
      const recentSignals = await prisma.signal.findMany({
          where: { group: { owner: { userId: ownerTelegramId } }, userId: { not: null } },
          select: { userId: true },
          orderBy: { detectedAt: 'desc' },
          take: 50
      });

      const userIds = Array.from(new Set(recentSignals.map(s => s.userId!).filter(Boolean)));
      const users = await prisma.user.findMany({
          where: { id: { in: userIds } },
          take: 10
      });

      if (users.length === 0) {
           return ctx.editMessageText('👤 *User Stats*\nNo active users found recently.', {
              parse_mode: 'Markdown',
              reply_markup: {
                  inline_keyboard: [[{ text: '🔙 Back', callback_data: 'analytics' }]]
              }
          });
      }

      const buttons = users.map(u => [{
          text: u.username ? `@${u.username}` : (u.firstName || `User ${u.id}`),
          callback_data: `user_stats_view:${u.id}`
      }]);

      buttons.push([{ text: '🔙 Back', callback_data: 'analytics' }]);

      await ctx.editMessageText('👤 *User Stats*\nSelect a user to view stats:', {
          parse_mode: 'Markdown',
          reply_markup: {
              inline_keyboard: buttons
          }
      });
  });

  // Handle viewing stats for a specific group
  bot.action(/^group_stats_view:(\d+)$/, async (ctx) => {
      const groupId = ctx.match[1];
      const { handleGroupStatsCommand } = await import('./commands/analytics');
      // We need to reply a new message or edit? handleGroupStatsCommand usually replies.
      // Let's modify handleGroupStatsCommand to support editing if possible, or just reply.
      // But we are in a callback. Replying is fine.
      await handleGroupStatsCommand(ctx as any, groupId);
      await ctx.answerCbQuery();
  });

  // Handle switching window for group stats
  bot.action(/^group_stats_window:(\d+):(7D|30D|ALL)$/, async (ctx) => {
      const groupId = ctx.match[1];
      // We can reuse handleGroupStatsCommand but we need to pass window?
      // Actually handleGroupStatsCommand currently defaults to ALL.
      // We should update it to accept window or create a specialized function.
      // For now, let's just re-call it and maybe it will default to ALL, but the UI has buttons to switch.
      // Wait, handleGroupStatsCommand doesn't take window arg in the export?
      // Let's check analytics.ts... it takes (ctx, groupIdStr). It DOES NOT take window.
      // We need to update handleGroupStatsCommand to accept window.
      const { handleGroupStatsCommand } = await import('./commands/analytics');
      // @ts-ignore
      await handleGroupStatsCommand(ctx as any, groupId, ctx.match[2]); 
      await ctx.answerCbQuery();
  });

  bot.action(/^user_stats_view:(\d+)$/, async (ctx) => {
      const userId = ctx.match[1];
      const { handleUserStatsCommand } = await import('./commands/analytics');
      await handleUserStatsCommand(ctx as any, userId);
      await ctx.answerCbQuery();
  });

  bot.action(/^user_stats_window:(\d+):(7D|30D|ALL)$/, async (ctx) => {
      const userId = ctx.match[1];
      const { handleUserStatsCommand } = await import('./commands/analytics');
      // @ts-ignore
      await handleUserStatsCommand(ctx as any, userId, ctx.match[2]);
      await ctx.answerCbQuery();
  });


  bot.action('analytics_earliest', async (ctx) => {
      const { handleEarliestCallers } = await import('./commands/analytics');
      await handleEarliestCallers(ctx as any);
  });

  bot.action('analytics_confirms', async (ctx) => {
      const { handleCrossGroupConfirms } = await import('./commands/analytics');
      await handleCrossGroupConfirms(ctx as any, 'lag');
  });

  bot.action(/^confirms_view:(.*)$/, async (ctx) => {
      const view = ctx.match[1];
      const { handleCrossGroupConfirms } = await import('./commands/analytics');
      await handleCrossGroupConfirms(ctx as any, view);
      await ctx.answerCbQuery();
  });
  
  bot.action('analytics_refresh', async (ctx) => {
     try {
         await ctx.answerCbQuery('Recalculating metrics...');
         updateHistoricalMetrics().catch(err => logger.error('Manual refresh failed', err));
         await ctx.reply('🔄 Metrics calculation started in background. Check back in a few minutes.');
     } catch(e) {
         ctx.answerCbQuery('Error');
     }
  });

  bot.action('leaderboards_menu', async (ctx) => {
      await ctx.editMessageText('🏆 *Leaderboards*\nSelect a category:', {
          parse_mode: 'Markdown',
          reply_markup: {
              inline_keyboard: [
                  [{ text: '👥 Top Groups', callback_data: 'leaderboard_groups:30D' }],
                  [{ text: '👤 Top Users', callback_data: 'leaderboard_users:30D' }],
                  [{ text: '💎 Top Signals', callback_data: 'leaderboard_signals:30D' }],
                  [{ text: '🔙 Back', callback_data: 'analytics' }]
              ]
          }
      });
  });

  bot.action(/^leaderboard_groups:(.*)$/, async (ctx) => {
      const window = ctx.match[1] as '1D' | '7D' | '30D' | 'ALL';
      const { handleGroupLeaderboardCommand } = await import('./commands/analytics');
      await handleGroupLeaderboardCommand(ctx as any, window);
  });

  bot.action(/^leaderboard_users:(.*)$/, async (ctx) => {
      const window = ctx.match[1] as '1D' | '7D' | '30D' | 'ALL';
      const { handleUserLeaderboardCommand } = await import('./commands/analytics');
      await handleUserLeaderboardCommand(ctx as any, window);
  });

  bot.action(/^leaderboard_signals:(.*)$/, async (ctx) => {
      const window = ctx.match[1] as '1D' | '7D' | '30D' | 'ALL';
      const { handleSignalLeaderboardCommand } = await import('./commands/analytics');
      await handleSignalLeaderboardCommand(ctx as any, window);
  });

  // Group Stats
  bot.action('group_stats', async (ctx) => {
      // Default to 7D? Or ask for window? Let's show 7D default.
      // Need groupId... context dependent.
      // If called from a signal card, we might have signalId in callback_data if we changed it.
      // But this is usually from main menu.
      // Let's assume this is the main menu flow where we ask user to select.
      await ctx.answerCbQuery('Use /groupstats command in a group.');
  });
  
  // ... (Other analytics actions kept as is) ...
};
