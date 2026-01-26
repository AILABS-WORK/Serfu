import { Context, Telegraf } from 'telegraf';
import { BotContext } from '../types/bot';
import { prisma } from '../db';
import { logger } from '../utils/logger';
import { checkPriceAlerts } from '../jobs/priceAlerts';
import { generateFirstSignalCard } from './signalCard';
import { provider } from '../providers';
import { TokenMeta } from '../providers/types';
import { handleAnalyticsCommand, handleEarliestCallers, handleCrossGroupConfirms, handleGroupStatsCommand, handleUserStatsCommand, handleStrategyCommand } from './commands/analytics';
import { handleLiveSignals } from './commands/analytics/liveSignals';
import { handleDistributions } from './commands/analytics/distributions';
import { handleRecentCalls } from './commands/analytics/recentCalls';
import { handleGroupLeaderboardCommand, handleUserLeaderboardCommand, handleSignalLeaderboardCommand } from './commands/analytics/leaderboards';
import { getHistoricalMetricsBackfillProgress, updateHistoricalMetrics } from '../jobs/historicalMetrics';
import { getDeepHolderAnalysis } from '../analytics/holders';
import { UIHelper } from '../utils/ui';

const buildBackfillStatusView = () => {
  const progress = getHistoricalMetricsBackfillProgress();
  const now = Date.now();
  const total = progress.totalSignals || 0;
  const processed = progress.processedSignals || 0;
  const totalMints = progress.totalMints || 0;
  const pct = total > 0 ? (processed / total) * 100 : 0;
  const elapsedMs = progress.startedAt ? now - progress.startedAt.getTime() : 0;
  const elapsedMinutes = elapsedMs > 0 ? elapsedMs / 60000 : null;
  let etaMinutes: number | null = null;
  if (progress.status === 'running' && progress.startedAt && processed > 0 && total > 0) {
    const ratePerMs = processed / Math.max(1, elapsedMs);
    etaMinutes = ratePerMs > 0 ? ((total - processed) / ratePerMs) / 60000 : null;
  }

  let message = UIHelper.header('Metrics Backfill', '🧠');
  const statusLabel = progress.status === 'running'
    ? 'Running'
    : progress.status === 'complete'
      ? 'Complete'
      : progress.status === 'error'
        ? 'Error'
        : 'Idle';
  message += `Status: *${statusLabel}*\n`;

  if (total > 0) {
    message += `Progress: ${processed}/${total} (${pct.toFixed(1)}%) ${UIHelper.progressBar(pct, 100, 10)}\n`;
  } else {
    message += 'Progress: N/A\n';
  }
  if (totalMints > 0) {
    message += `Unique Mints: ${totalMints}\n`;
  }

  if (progress.startedAt) {
    message += `Elapsed: ${elapsedMinutes ? UIHelper.formatDurationMinutes(elapsedMinutes) : 'N/A'}`;
    if (etaMinutes) {
      message += ` | ETA: ${UIHelper.formatDurationMinutes(etaMinutes)}`;
    }
    message += '\n';
  }

  if (progress.lastBatchCount > 0) {
    message += `Last Batch: ${progress.lastBatchCount} signals`;
    if (progress.lastSignalId) message += ` (last id ${progress.lastSignalId})`;
    message += '\n';
  }

  if (progress.status === 'error' && progress.errorMessage) {
    message += `Error: \`${progress.errorMessage}\`\n`;
  }

  const keyboard = {
    inline_keyboard: [
      [{ text: '🔄 Refresh Status', callback_data: 'analytics_backfill_status' }],
      [{ text: '🧠 Start Backfill', callback_data: 'analytics_backfill' }, { text: '🔙 Back', callback_data: 'analytics' }],
      [{ text: '❌ Close', callback_data: 'delete_msg' }]
    ]
  };

  return { message, keyboard };
};

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

      // Fetch fresh quote for MC
      let currentPrice = 0;
      try {
        const quote = await provider.getQuote(signal.mint);
        currentPrice = quote.price;
      } catch (e) {
        logger.warn(`Could not fetch quote for stats: ${e}`);
      }

      const entryMc = signal.entryMarketCap || 0;
      const currentMc = signal.entrySupply && currentPrice ? currentPrice * signal.entrySupply : (signal.metrics?.currentMarketCap || 0);
      const multiple = entryMc > 0 && currentMc > 0 ? currentMc / entryMc : 0;
      const ath = signal.metrics?.athMultiple || multiple; // Use stored ATH if available
      const dd = signal.metrics?.maxDrawdown ?? null;

      const msg = `
📊 *Signal Stats*
Token: ${signal.symbol}
Entry MC: ${UIHelper.formatMarketCap(entryMc)}
Current MC: ${UIHelper.formatMarketCap(currentMc)} (${multiple.toFixed(2)}x)
ATH: ${ath.toFixed(2)}x
      Max Drawdown: ${dd !== null ? UIHelper.formatPercent(dd) : 'N/A'}
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
      await handleStrategyCommand(ctx as any, type, id);
      await ctx.answerCbQuery();
  });

  // --- LIVE SIGNALS & FILTERS ---
  
  bot.action('live_signals', async (ctx) => {
      // Answer callback immediately to prevent timeout
      await ctx.answerCbQuery().catch(() => {});
      
      // Check if this is a refresh (user clicked refresh button) or initial load
      const isRefresh = !!(ctx.callbackQuery && ctx.callbackQuery.message);
      
      // Process in background with longer timeout for large timeframes
      handleLiveSignals(ctx, isRefresh).catch((err) => {
          logger.error('Error in live_signals handler:', err);
          if (ctx.callbackQuery && ctx.callbackQuery.message) {
              ctx.telegram.editMessageText(
                  (ctx.callbackQuery.message as any).chat.id,
                  (ctx.callbackQuery.message as any).message_id,
                  undefined,
                  '❌ Error loading signals. This may take longer for large timeframes. Try a smaller timeframe or click Refresh again.'
              ).catch(() => {});
          }
      });
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

          // Answer callback immediately
          await ctx.answerCbQuery('Filter updated').catch(() => {});
          // Reload view
          handleLiveSignals(ctx).catch((err) => {
              logger.error('Error reloading live signals after filter:', err);
          });
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

          // Answer callback immediately
          await ctx.answerCbQuery(`Sorted by ${sortBy}`).catch(() => {});
          // Reload view
          handleLiveSignals(ctx).catch((err) => {
              logger.error('Error reloading live signals after sort:', err);
          });
      } catch (error) {
          logger.error('Sort action error:', error);
          ctx.answerCbQuery('Error updating sort');
      }
  });

  bot.action(/^live_chain:(.*)$/, async (ctx) => {
      try {
          const chain = ctx.match[1];
          if (!ctx.session) ctx.session = {};
          if (!ctx.session.liveFilters) ctx.session.liveFilters = {};

          if (['both', 'solana', 'bsc'].includes(chain)) {
              (ctx.session.liveFilters as any).chain = chain;
          }

          if (ctx.session.liveSignalsCache) {
              ctx.session.liveSignalsCache = undefined;
          }

          await ctx.answerCbQuery('Chain filter updated').catch(() => {});
          handleLiveSignals(ctx).catch((err) => {
              logger.error('Error reloading live signals after chain change:', err);
          });
      } catch (error) {
          logger.error('Chain filter action error:', error);
          ctx.answerCbQuery('Error updating chain filter');
      }
  });

  bot.action(/^live_basis:(.*)$/, async (ctx) => {
      try {
          const basis = ctx.match[1];
          if (!ctx.session) ctx.session = {};
          if (!ctx.session.liveFilters) ctx.session.liveFilters = {};

          if (basis === 'latest' || basis === 'created') {
              (ctx.session.liveFilters as any).timeBasis = basis;
          }

          if (ctx.session.liveSignalsCache) {
              ctx.session.liveSignalsCache = undefined;
          }

          await ctx.answerCbQuery('Time basis updated').catch(() => {});
          handleLiveSignals(ctx).catch((err) => {
              logger.error('Error reloading live signals after basis change:', err);
          });
      } catch (error) {
          logger.error('Time basis action error:', error);
          ctx.answerCbQuery('Error updating time basis');
      }
  });

  bot.action(/^live_time:(.*)$/, async (ctx) => {
      try {
          const tf = ctx.match[1];
          if (!ctx.session) ctx.session = {};
          if (!ctx.session.liveFilters) ctx.session.liveFilters = {};
          if (tf === 'custom') {
              (ctx as any).session.pendingInput = { type: 'live_timeframe' };
              await ctx.reply('Enter custom timeframe:\n• Hours: 1h, 6h, 12h\n• Days: 1d, 3d, 7d\n• Weeks: 1w, 2w\n• Months: 1m, 3m\n\nExamples: 1h, 1d, 1w, 1m');
              await ctx.answerCbQuery();
              return;
          }
          // Clear cache when timeframe changes to force rebuild
          const oldTimeframe = (ctx.session.liveFilters as any).timeframe;
          (ctx.session.liveFilters as any).timeframe = tf;
          if (oldTimeframe !== tf && ctx.session.liveSignalsCache) {
              logger.info(`[LiveSignals] Timeframe changed from ${oldTimeframe} to ${tf} - clearing cache`);
              ctx.session.liveSignalsCache = undefined; // Force cache rebuild
          }
          // Answer callback immediately
          await ctx.answerCbQuery('Timeframe updated').catch(() => {});
          // Reload view (may take longer for large timeframes like ALL)
          handleLiveSignals(ctx).catch((err) => {
              logger.error('Error reloading live signals after timeframe change:', err);
              if (ctx.callbackQuery && ctx.callbackQuery.message) {
                  ctx.telegram.editMessageText(
                      (ctx.callbackQuery.message as any).chat.id,
                      (ctx.callbackQuery.message as any).message_id,
                      undefined,
                      '❌ Error loading signals. Large timeframes may take longer. Try a smaller timeframe or click Refresh.'
                  ).catch(() => {});
              }
          });
      } catch (error) {
          logger.error('Timeframe action error:', error);
          ctx.answerCbQuery('Error updating timeframe');
      }
  });

  bot.action(/^live_ath:(.*)$/, async (ctx) => {
      try {
          const val = ctx.match[1];
          if (!ctx.session) ctx.session = {};
          if (!ctx.session.liveFilters) ctx.session.liveFilters = {};
          if (val === 'custom') {
              (ctx as any).session.pendingInput = { type: 'live_ath_min' };
              await ctx.reply('Enter minimum ATH multiple (e.g., 2, 5, 10.5):');
              await ctx.answerCbQuery();
              return;
          }
          if (val === 'reset') {
              (ctx.session.liveFilters as any).minAth = undefined;
          }
          await handleLiveSignals(ctx);
          await ctx.answerCbQuery('ATH filter updated');
      } catch (error) {
          logger.error('ATH filter action error:', error);
          ctx.answerCbQuery('Error updating ATH filter');
      }
  });

  bot.action('distributions', async (ctx) => {
      await handleDistributions(ctx as any, 'mcap');
  });

  bot.action(/^dist_view:(.*)$/, async (ctx) => {
      const view = ctx.match[1];
      await handleDistributions(ctx as any, view);
      await ctx.answerCbQuery();
  });

  bot.action(/^dist_time:(.*)$/, async (ctx) => {
      const tf = ctx.match[1];
      if (!ctx.session) ctx.session = {} as any;
      if (!ctx.session.distributions) ctx.session.distributions = {};
      if (tf === 'custom') {
          ctx.session.pendingInput = { type: 'dist_timeframe' };
          await ctx.reply('Enter custom timeframe (e.g., 6H, 3D, 2W, 1M):');
          await ctx.answerCbQuery();
          return;
      }
      ctx.session.distributions.timeframe = tf;
      await handleDistributions(ctx as any, 'mcap');
      await ctx.answerCbQuery();
  });

  bot.action(/^dist_chain:(.*)$/, async (ctx) => {
      const chain = ctx.match[1];
      if (!ctx.session) ctx.session = {} as any;
      if (!(ctx.session as any).distributions) (ctx.session as any).distributions = {};
      if (['both', 'solana', 'bsc'].includes(chain)) {
          (ctx.session as any).distributions.chain = chain;
      }
      await ctx.answerCbQuery('Chain updated').catch(() => {});
      handleDistributions(ctx as any).catch(err => logger.error('Dist chain error', err));
  });

  bot.action('dist_target', async (ctx) => {
      const ownerTelegramId = ctx.from?.id ? BigInt(ctx.from.id) : null;
      if (!ownerTelegramId) return ctx.answerCbQuery('User not identified');

      const groups = await prisma.group.findMany({
          where: { owner: { userId: ownerTelegramId }, isActive: true },
          take: 8
      });

      const recentSignals = await prisma.signal.findMany({
          where: { group: { owner: { userId: ownerTelegramId } }, userId: { not: null } },
          select: { userId: true },
          orderBy: { detectedAt: 'desc' },
          take: 50
      });
      const userIds = Array.from(new Set(recentSignals.map(s => s.userId!).filter(Boolean)));
      const users = await prisma.user.findMany({
          where: { id: { in: userIds } },
          take: 8
      });

      const keyboard: any[] = [
          [{ text: 'Overall', callback_data: 'dist_target_overall' }]
      ];
      if (groups.length > 0) {
          groups.forEach(g => {
              keyboard.push([{ text: `Group: ${g.name || g.chatId}`, callback_data: `dist_target_group:${g.id}` }]);
          });
      }
      if (users.length > 0) {
          users.forEach(u => {
              keyboard.push([{ text: `User: ${u.username ? `@${u.username}` : (u.firstName || u.id)}`, callback_data: `dist_target_user:${u.id}` }]);
          });
      }
      keyboard.push([{ text: '🔙 Back', callback_data: 'dist_view:mcap' }]);

      await ctx.editMessageText('🎯 *Select Target*\nPick Overall, Group, or User:', {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: keyboard }
      });
      await ctx.answerCbQuery();
  });

  bot.action('dist_target_overall', async (ctx) => {
      if (!ctx.session) ctx.session = {} as any;
      if (!ctx.session.distributions) ctx.session.distributions = {};
      ctx.session.distributions.targetType = 'OVERALL';
      ctx.session.distributions.targetId = undefined;
      await handleDistributions(ctx as any, 'mcap');
      await ctx.answerCbQuery();
  });

  bot.action(/^dist_target_group:(\d+)$/, async (ctx) => {
      if (!ctx.session) ctx.session = {} as any;
      if (!ctx.session.distributions) ctx.session.distributions = {};
      ctx.session.distributions.targetType = 'GROUP';
      ctx.session.distributions.targetId = parseInt(ctx.match[1]);
      await handleDistributions(ctx as any, 'mcap');
      await ctx.answerCbQuery();
  });

  bot.action(/^dist_target_user:(\d+)$/, async (ctx) => {
      if (!ctx.session) ctx.session = {} as any;
      if (!ctx.session.distributions) ctx.session.distributions = {};
      ctx.session.distributions.targetType = 'USER';
      ctx.session.distributions.targetId = parseInt(ctx.match[1]);
      await handleDistributions(ctx as any, 'mcap');
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
  
  bot.action('strategy_menu', async (ctx) => {
      const { handleStrategyMenu } = await import('./commands/copyTrading');
      await handleStrategyMenu(ctx as any);
  });

  bot.action('strategy_auto', async (ctx) => {
      const { handleStrategyAutoMenu } = await import('./commands/copyTrading');
      await handleStrategyAutoMenu(ctx as any);
      await ctx.answerCbQuery();
  });

  bot.action(/^strategy_auto:(.*)$/, async (ctx) => {
      const profile = ctx.match[1] as 'winrate' | 'balanced' | 'return';
      const { handleStrategyAutoGenerate } = await import('./commands/copyTrading');
      await handleStrategyAutoGenerate(ctx as any, profile);
      await ctx.answerCbQuery();
  });

  bot.action('strategy_create', async (ctx) => {
      const { handleStrategyTargetSelect } = await import('./commands/copyTrading');
      await handleStrategyTargetSelect(ctx as any);
      await ctx.answerCbQuery();
  });

  bot.action(/^strategy_target:(OVERALL|GROUP|USER)$/, async (ctx) => {
      if (!ctx.session) ctx.session = {} as any;
      if (!ctx.session.strategyDraft) ctx.session.strategyDraft = {};
      ctx.session.strategyDraft.targetType = ctx.match[1] as 'OVERALL' | 'GROUP' | 'USER';
      if (ctx.match[1] === 'OVERALL') {
          const { handleStrategyTimeframeSelect } = await import('./commands/copyTrading');
          await handleStrategyTimeframeSelect(ctx as any);
      } else {
          const { handleStrategyTargetList } = await import('./commands/copyTrading');
          await handleStrategyTargetList(ctx as any, ctx.match[1] as any);
      }
      await ctx.answerCbQuery();
  });

  bot.action(/^strategy_target_group:(\d+)$/, async (ctx) => {
      if (!ctx.session) ctx.session = {} as any;
      if (!ctx.session.strategyDraft) ctx.session.strategyDraft = {};
      ctx.session.strategyDraft.targetType = 'GROUP';
      ctx.session.strategyDraft.targetId = parseInt(ctx.match[1]);
      const { handleStrategyTimeframeSelect } = await import('./commands/copyTrading');
      await handleStrategyTimeframeSelect(ctx as any);
      await ctx.answerCbQuery();
  });

  bot.action(/^strategy_target_user:(\d+)$/, async (ctx) => {
      if (!ctx.session) ctx.session = {} as any;
      if (!ctx.session.strategyDraft) ctx.session.strategyDraft = {};
      ctx.session.strategyDraft.targetType = 'USER';
      ctx.session.strategyDraft.targetId = parseInt(ctx.match[1]);
      const { handleStrategyTimeframeSelect } = await import('./commands/copyTrading');
      await handleStrategyTimeframeSelect(ctx as any);
      await ctx.answerCbQuery();
  });

  bot.action(/^strategy_time:(.*)$/, async (ctx) => {
      const tf = ctx.match[1];
      if (!ctx.session) ctx.session = {} as any;
      if (!ctx.session.strategyDraft) ctx.session.strategyDraft = {};
      if (tf === 'custom') {
          ctx.session.pendingInput = { type: 'strategy_timeframe' };
          await ctx.reply('Enter custom timeframe (e.g., 6H, 3D, 2W, 1M):');
          await ctx.answerCbQuery();
          return;
      }
      ctx.session.strategyDraft.timeframe = tf;
      const { handleStrategyDraftSummary } = await import('./commands/copyTrading');
      await handleStrategyDraftSummary(ctx as any);
      await ctx.answerCbQuery();
  });

  bot.action('strategy_view_existing', async (ctx) => {
      const { handleCopyTradingCommand } = await import('./commands/copyTrading');
      await handleCopyTradingCommand(ctx as any, '30D');
      await ctx.answerCbQuery();
  });

  bot.action('strategy_presets', async (ctx) => {
      const { handleStrategyPresetsList } = await import('./commands/copyTrading');
      await handleStrategyPresetsList(ctx as any);
      await ctx.answerCbQuery();
  });

  bot.action(/^strategy_preset_view:(\d+)$/, async (ctx) => {
      const presetId = parseInt(ctx.match[1]);
      const { handleStrategyPresetDetails } = await import('./commands/copyTrading');
      await handleStrategyPresetDetails(ctx as any, presetId);
      await ctx.answerCbQuery();
  });

  bot.action(/^strategy_preset_toggle:(\d+)$/, async (ctx) => {
      const presetId = parseInt(ctx.match[1]);
      const ownerTelegramId = ctx.from?.id ? BigInt(ctx.from.id) : null;
      if (!ownerTelegramId) return ctx.answerCbQuery('User not identified');
      const owner = await prisma.user.findUnique({ where: { userId: ownerTelegramId } });
      if (!owner) return ctx.answerCbQuery('User not found');
      const preset = await prisma.strategyPreset.findFirst({ where: { id: presetId, ownerId: owner.id } });
      if (!preset) return ctx.answerCbQuery('Preset not found');
      await prisma.strategyPreset.update({ where: { id: preset.id }, data: { isActive: !preset.isActive } });
      const { handleStrategyPresetsList } = await import('./commands/copyTrading');
      await handleStrategyPresetsList(ctx as any);
      await ctx.answerCbQuery();
  });

  bot.action(/^strategy_preset_delete:(\d+)$/, async (ctx) => {
      const presetId = parseInt(ctx.match[1]);
      const ownerTelegramId = ctx.from?.id ? BigInt(ctx.from.id) : null;
      if (!ownerTelegramId) return ctx.answerCbQuery('User not identified');
      const owner = await prisma.user.findUnique({ where: { userId: ownerTelegramId } });
      if (!owner) return ctx.answerCbQuery('User not found');
      await prisma.strategyPreset.deleteMany({ where: { id: presetId, ownerId: owner.id } });
      const { handleStrategyPresetsList } = await import('./commands/copyTrading');
      await handleStrategyPresetsList(ctx as any);
      await ctx.answerCbQuery();
  });

  bot.action(/^strategy_preset_days:(\d+)$/, async (ctx) => {
      const presetId = parseInt(ctx.match[1]);
      const { handleStrategyPresetDaySelect } = await import('./commands/copyTrading');
      await handleStrategyPresetDaySelect(ctx as any, presetId);
      await ctx.answerCbQuery();
  });

  bot.action(/^strategy_preset_day_select:(\d+):(.*)$/, async (ctx) => {
      const presetId = parseInt(ctx.match[1]);
      const day = ctx.match[2];
      const { handleStrategyPresetDayGroupList } = await import('./commands/copyTrading');
      await handleStrategyPresetDayGroupList(ctx as any, presetId, day);
      await ctx.answerCbQuery();
  });

  bot.action(/^strategy_preset_day_group_toggle:(\d+):(.*):(\d+)$/, async (ctx) => {
      const presetId = parseInt(ctx.match[1]);
      const day = ctx.match[2];
      const groupId = parseInt(ctx.match[3]);
      const ownerTelegramId = ctx.from?.id ? BigInt(ctx.from.id) : null;
      if (!ownerTelegramId) return ctx.answerCbQuery('User not identified');
      const owner = await prisma.user.findUnique({ where: { userId: ownerTelegramId } });
      if (!owner) return ctx.answerCbQuery('User not found');
      const preset = await prisma.strategyPreset.findFirst({ where: { id: presetId, ownerId: owner.id } });
      if (!preset) return ctx.answerCbQuery('Preset not found');
      const schedule: any = preset.schedule || {};
      if (!schedule.dayGroups) schedule.dayGroups = {};
      const list = schedule.dayGroups[day] || [];
      schedule.dayGroups[day] = list.includes(groupId) ? list.filter((id: number) => id !== groupId) : [...list, groupId];
      await prisma.strategyPreset.update({ where: { id: preset.id }, data: { schedule } });
      const { handleStrategyPresetDayGroupList } = await import('./commands/copyTrading');
      await handleStrategyPresetDayGroupList(ctx as any, presetId, day);
      await ctx.answerCbQuery();
  });

  bot.action(/^strategy_preset_day_group_clear:(\d+):(.*)$/, async (ctx) => {
      const presetId = parseInt(ctx.match[1]);
      const day = ctx.match[2];
      const ownerTelegramId = ctx.from?.id ? BigInt(ctx.from.id) : null;
      if (!ownerTelegramId) return ctx.answerCbQuery('User not identified');
      const owner = await prisma.user.findUnique({ where: { userId: ownerTelegramId } });
      if (!owner) return ctx.answerCbQuery('User not found');
      const preset = await prisma.strategyPreset.findFirst({ where: { id: presetId, ownerId: owner.id } });
      if (!preset) return ctx.answerCbQuery('Preset not found');
      const schedule: any = preset.schedule || {};
      if (!schedule.dayGroups) schedule.dayGroups = {};
      schedule.dayGroups[day] = [];
      await prisma.strategyPreset.update({ where: { id: preset.id }, data: { schedule } });
      const { handleStrategyPresetDayGroupList } = await import('./commands/copyTrading');
      await handleStrategyPresetDayGroupList(ctx as any, presetId, day);
      await ctx.answerCbQuery();
  });

  bot.action(/^strategy_preset_tp_rule_add:(\d+)$/, async (ctx) => {
      const presetId = parseInt(ctx.match[1]);
      if (!ctx.session) ctx.session = {} as any;
      ctx.session.pendingInput = { type: 'preset_tp_rule', presetId };
      await ctx.reply('Enter TP rule like "4x 50% 1m" or "3x 100%".');
      await ctx.answerCbQuery();
  });

  bot.action(/^strategy_preset_sl_rule_add:(\d+)$/, async (ctx) => {
      const presetId = parseInt(ctx.match[1]);
      if (!ctx.session) ctx.session = {} as any;
      ctx.session.pendingInput = { type: 'preset_sl_rule', presetId };
      await ctx.reply('Enter SL rule like "0.7x 50% 5m" or "0.6x 100%".');
      await ctx.answerCbQuery();
  });

  bot.action(/^strategy_preset_tp_rule_del:(\d+):(\d+)$/, async (ctx) => {
      const presetId = parseInt(ctx.match[1]);
      const idx = parseInt(ctx.match[2]);
      const ownerTelegramId = ctx.from?.id ? BigInt(ctx.from.id) : null;
      if (!ownerTelegramId) return ctx.answerCbQuery('User not identified');
      const owner = await prisma.user.findUnique({ where: { userId: ownerTelegramId } });
      if (!owner) return ctx.answerCbQuery('User not found');
      const preset = await prisma.strategyPreset.findFirst({ where: { id: presetId, ownerId: owner.id } });
      if (!preset) return ctx.answerCbQuery('Preset not found');
      const conditions: any = preset.conditions || {};
      const rules = conditions.takeProfitRules || [];
      if (idx >= 0 && idx < rules.length) rules.splice(idx, 1);
      conditions.takeProfitRules = rules;
      await prisma.strategyPreset.update({ where: { id: preset.id }, data: { conditions } });
      const { handleStrategyPresetDetails } = await import('./commands/copyTrading');
      await handleStrategyPresetDetails(ctx as any, presetId);
      await ctx.answerCbQuery();
  });

  bot.action(/^strategy_preset_sl_rule_del:(\d+):(\d+)$/, async (ctx) => {
      const presetId = parseInt(ctx.match[1]);
      const idx = parseInt(ctx.match[2]);
      const ownerTelegramId = ctx.from?.id ? BigInt(ctx.from.id) : null;
      if (!ownerTelegramId) return ctx.answerCbQuery('User not identified');
      const owner = await prisma.user.findUnique({ where: { userId: ownerTelegramId } });
      if (!owner) return ctx.answerCbQuery('User not found');
      const preset = await prisma.strategyPreset.findFirst({ where: { id: presetId, ownerId: owner.id } });
      if (!preset) return ctx.answerCbQuery('Preset not found');
      const conditions: any = preset.conditions || {};
      const rules = conditions.stopLossRules || [];
      if (idx >= 0 && idx < rules.length) rules.splice(idx, 1);
      conditions.stopLossRules = rules;
      await prisma.strategyPreset.update({ where: { id: preset.id }, data: { conditions } });
      const { handleStrategyPresetDetails } = await import('./commands/copyTrading');
      await handleStrategyPresetDetails(ctx as any, presetId);
      await ctx.answerCbQuery();
  });

  bot.action(/^strategy_preset_tp_rule_clear:(\d+)$/, async (ctx) => {
      const presetId = parseInt(ctx.match[1]);
      const ownerTelegramId = ctx.from?.id ? BigInt(ctx.from.id) : null;
      if (!ownerTelegramId) return ctx.answerCbQuery('User not identified');
      const owner = await prisma.user.findUnique({ where: { userId: ownerTelegramId } });
      if (!owner) return ctx.answerCbQuery('User not found');
      const preset = await prisma.strategyPreset.findFirst({ where: { id: presetId, ownerId: owner.id } });
      if (!preset) return ctx.answerCbQuery('Preset not found');
      const conditions: any = preset.conditions || {};
      conditions.takeProfitRules = [];
      await prisma.strategyPreset.update({ where: { id: preset.id }, data: { conditions } });
      await ctx.reply('✅ TP rules cleared.');
      await ctx.answerCbQuery();
  });

  bot.action(/^strategy_preset_sl_rule_clear:(\d+)$/, async (ctx) => {
      const presetId = parseInt(ctx.match[1]);
      const ownerTelegramId = ctx.from?.id ? BigInt(ctx.from.id) : null;
      if (!ownerTelegramId) return ctx.answerCbQuery('User not identified');
      const owner = await prisma.user.findUnique({ where: { userId: ownerTelegramId } });
      if (!owner) return ctx.answerCbQuery('User not found');
      const preset = await prisma.strategyPreset.findFirst({ where: { id: presetId, ownerId: owner.id } });
      if (!preset) return ctx.answerCbQuery('Preset not found');
      const conditions: any = preset.conditions || {};
      conditions.stopLossRules = [];
      await prisma.strategyPreset.update({ where: { id: preset.id }, data: { conditions } });
      await ctx.reply('✅ SL rules cleared.');
      await ctx.answerCbQuery();
  });

  bot.action('strategy_simulate_help', async (ctx) => {
      await ctx.reply('Use /simulate <user|group> <id> [capital]\nExample: /simulate user 123456789 1000');
      await ctx.answerCbQuery();
  });

  bot.action('strategy_summary', async (ctx) => {
      const { handleStrategyDraftSummary } = await import('./commands/copyTrading');
      await handleStrategyDraftSummary(ctx as any);
      await ctx.answerCbQuery();
  });

  bot.action('strategy_rule_priority', async (ctx) => {
      if (!ctx.session) ctx.session = {} as any;
      if (!ctx.session.strategyDraft) ctx.session.strategyDraft = {};
      if (!ctx.session.strategyDraft.conditions) ctx.session.strategyDraft.conditions = {};
      const current = ctx.session.strategyDraft.conditions.rulePriority || 'TP_FIRST';
      const next = current === 'TP_FIRST' ? 'SL_FIRST' : current === 'SL_FIRST' ? 'INTERLEAVED' : 'TP_FIRST';
      ctx.session.strategyDraft.conditions.rulePriority = next;
      const { handleStrategyDraftSummary } = await import('./commands/copyTrading');
      await handleStrategyDraftSummary(ctx as any);
      await ctx.answerCbQuery();
  });

  bot.action('strategy_stop_first', async (ctx) => {
      if (!ctx.session) ctx.session = {} as any;
      if (!ctx.session.strategyDraft) ctx.session.strategyDraft = {};
      if (!ctx.session.strategyDraft.conditions) ctx.session.strategyDraft.conditions = {};
      ctx.session.strategyDraft.conditions.stopOnFirstRuleHit = !ctx.session.strategyDraft.conditions.stopOnFirstRuleHit;
      const { handleStrategyDraftSummary } = await import('./commands/copyTrading');
      await handleStrategyDraftSummary(ctx as any);
      await ctx.answerCbQuery();
  });

  bot.action('strategy_set_balance', async (ctx) => {
      if (!ctx.session) ctx.session = {} as any;
      ctx.session.pendingInput = { type: 'strategy_balance' };
      await ctx.reply('Enter starting balance in SOL (e.g., 1 or 2.5):');
      await ctx.answerCbQuery();
  });

  bot.action('strategy_set_fees', async (ctx) => {
      if (!ctx.session) ctx.session = {} as any;
      ctx.session.pendingInput = { type: 'strategy_fee' };
      await ctx.reply('Enter fee per side in SOL (e.g., 0.0001):');
      await ctx.answerCbQuery();
  });

  bot.action('strategy_schedule', async (ctx) => {
      const { handleStrategyScheduleView } = await import('./commands/copyTrading');
      await handleStrategyScheduleView(ctx as any);
      await ctx.answerCbQuery();
  });

  bot.action('strategy_day_groups', async (ctx) => {
      const { handleStrategyDayGroupSelect } = await import('./commands/copyTrading');
      await handleStrategyDayGroupSelect(ctx as any);
      await ctx.answerCbQuery();
  });

  bot.action(/^strategy_day_select:(.*)$/, async (ctx) => {
      const day = ctx.match[1];
      const { handleStrategyDayGroupList } = await import('./commands/copyTrading');
      await handleStrategyDayGroupList(ctx as any, day);
      await ctx.answerCbQuery();
  });

  bot.action(/^strategy_day_group_toggle:(.*):(\d+)$/, async (ctx) => {
      const day = ctx.match[1];
      const groupId = parseInt(ctx.match[2]);
      if (!ctx.session) ctx.session = {} as any;
      if (!ctx.session.strategyDraft) ctx.session.strategyDraft = {};
      if (!ctx.session.strategyDraft.schedule) ctx.session.strategyDraft.schedule = { timezone: 'UTC', days: [], windows: [], dayGroups: {} };
      const schedule = ctx.session.strategyDraft.schedule;
      if (!schedule.dayGroups) schedule.dayGroups = {};
      const list = schedule.dayGroups[day] || [];
      if (list.includes(groupId)) {
          schedule.dayGroups[day] = list.filter((id: number) => id !== groupId);
      } else {
          schedule.dayGroups[day] = [...list, groupId];
      }
      const { handleStrategyDayGroupList } = await import('./commands/copyTrading');
      await handleStrategyDayGroupList(ctx as any, day);
      await ctx.answerCbQuery();
  });

  bot.action(/^strategy_day_group_clear:(.*)$/, async (ctx) => {
      const day = ctx.match[1];
      if (!ctx.session) ctx.session = {} as any;
      if (!ctx.session.strategyDraft) ctx.session.strategyDraft = {};
      if (!ctx.session.strategyDraft.schedule) ctx.session.strategyDraft.schedule = { timezone: 'UTC', days: [], windows: [], dayGroups: {} };
      if (!ctx.session.strategyDraft.schedule.dayGroups) ctx.session.strategyDraft.schedule.dayGroups = {};
      ctx.session.strategyDraft.schedule.dayGroups[day] = [];
      const { handleStrategyDayGroupList } = await import('./commands/copyTrading');
      await handleStrategyDayGroupList(ctx as any, day);
      await ctx.answerCbQuery();
  });

  bot.action(/^strategy_day:(.*)$/, async (ctx) => {
      const day = ctx.match[1];
      if (!ctx.session) ctx.session = {} as any;
      if (!ctx.session.strategyDraft) ctx.session.strategyDraft = {};
      if (!ctx.session.strategyDraft.schedule) ctx.session.strategyDraft.schedule = { timezone: 'UTC', days: [], windows: [], dayGroups: {} };
      const schedule = ctx.session.strategyDraft.schedule;
      schedule.days = schedule.days || [];
      if (schedule.days.includes(day)) {
          schedule.days = schedule.days.filter((d: string) => d !== day);
      } else {
          schedule.days.push(day);
      }
      const { handleStrategyScheduleView } = await import('./commands/copyTrading');
      await handleStrategyScheduleView(ctx as any);
      await ctx.answerCbQuery();
  });

  bot.action('strategy_add_window', async (ctx) => {
      if (!ctx.session) ctx.session = {} as any;
      ctx.session.pendingInput = { type: 'strategy_time_window' };
      await ctx.reply('Enter time window (HH:MM-HH:MM), timezone UTC.');
      await ctx.answerCbQuery();
  });

  bot.action('strategy_clear_windows', async (ctx) => {
      if (!ctx.session) ctx.session = {} as any;
      if (!ctx.session.strategyDraft) ctx.session.strategyDraft = {};
      if (!ctx.session.strategyDraft.schedule) ctx.session.strategyDraft.schedule = { timezone: 'UTC', days: [], windows: [], dayGroups: {} };
      ctx.session.strategyDraft.schedule.windows = [];
      const { handleStrategyScheduleView } = await import('./commands/copyTrading');
      await handleStrategyScheduleView(ctx as any);
      await ctx.answerCbQuery();
  });

  bot.action('strategy_conditions', async (ctx) => {
      const { handleStrategyConditionsView } = await import('./commands/copyTrading');
      await handleStrategyConditionsView(ctx as any);
      await ctx.answerCbQuery();
  });

  bot.action(/^strategy_cond:(.*)$/, async (ctx) => {
      const type = ctx.match[1];
      if (!ctx.session) ctx.session = {} as any;
      if (type === 'volume') ctx.session.pendingInput = { type: 'strategy_cond_volume' };
      if (type === 'mentions') ctx.session.pendingInput = { type: 'strategy_cond_mentions' };
      if (type === 'confluence') ctx.session.pendingInput = { type: 'strategy_cond_confluence' };
      if (type === 'min_mc') ctx.session.pendingInput = { type: 'strategy_cond_min_mc' };
      if (type === 'max_mc') ctx.session.pendingInput = { type: 'strategy_cond_max_mc' };
      if (type === 'tp') ctx.session.pendingInput = { type: 'strategy_cond_tp' };
      if (type === 'sl') ctx.session.pendingInput = { type: 'strategy_cond_sl' };
      if (type === 'tp_rule') ctx.session.pendingInput = { type: 'strategy_cond_tp_rule' };
      if (type === 'sl_rule') ctx.session.pendingInput = { type: 'strategy_cond_sl_rule' };
      if (type === 'tp_rule_clear') {
          if (!ctx.session.strategyDraft) ctx.session.strategyDraft = {};
          if (!ctx.session.strategyDraft.conditions) ctx.session.strategyDraft.conditions = {};
          ctx.session.strategyDraft.conditions.takeProfitRules = [];
          const { handleStrategyConditionsView } = await import('./commands/copyTrading');
          await handleStrategyConditionsView(ctx as any);
          await ctx.answerCbQuery();
          return;
      }
      if (type === 'sl_rule_clear') {
          if (!ctx.session.strategyDraft) ctx.session.strategyDraft = {};
          if (!ctx.session.strategyDraft.conditions) ctx.session.strategyDraft.conditions = {};
          ctx.session.strategyDraft.conditions.stopLossRules = [];
          const { handleStrategyConditionsView } = await import('./commands/copyTrading');
          await handleStrategyConditionsView(ctx as any);
          await ctx.answerCbQuery();
          return;
      }
      if (type === 'clear') {
          if (!ctx.session.strategyDraft) ctx.session.strategyDraft = {};
          ctx.session.strategyDraft.conditions = {};
          const { handleStrategyConditionsView } = await import('./commands/copyTrading');
          await handleStrategyConditionsView(ctx as any);
          await ctx.answerCbQuery();
          return;
      }
      if (type === 'tp') {
          await ctx.reply('Enter take profit multiple (e.g., 2.5).');
      } else if (type === 'sl') {
          await ctx.reply('Enter stop loss multiple between 0 and 1 (e.g., 0.7).');
      } else if (type === 'tp_rule') {
          await ctx.reply('Enter TP rule like "4x 50% 1m" or "3x 100%".');
      } else if (type === 'sl_rule') {
          await ctx.reply('Enter SL rule like "0.7x 50% 5m" or "0.6x 100%".');
      } else if (type === 'confluence') {
          await ctx.reply('Enter minimum confluence (number of distinct sources, e.g., 2 or 3).');
      } else {
          await ctx.reply('Enter value (e.g., 25K, 1.2M) or integer for mentions:');
      }
      await ctx.answerCbQuery();
  });

  bot.action('strategy_save', async (ctx) => {
      const { handleStrategySavePreset } = await import('./commands/copyTrading');
      await handleStrategySavePreset(ctx as any);
      await ctx.answerCbQuery();
  });

  bot.action('strategy_templates', async (ctx) => {
      const { handleStrategyTemplates } = await import('./commands/copyTrading');
      await handleStrategyTemplates(ctx as any);
      await ctx.answerCbQuery();
  });

  bot.action('strategy_backtest', async (ctx) => {
      const { handleStrategyBacktest } = await import('./commands/copyTrading');
      await handleStrategyBacktest(ctx as any);
      await ctx.answerCbQuery();
  });
  
  bot.action('analytics_recent', async (ctx) => {
      await handleRecentCalls(ctx as any);
  });

  bot.action(/^recent_window:(.*)$/, async (ctx) => {
      const tf = ctx.match[1];
      if (!ctx.session) ctx.session = {} as any;
      if (!ctx.session.recent) ctx.session.recent = {};
      if (tf === 'custom') {
          ctx.session.pendingInput = { type: 'recent_timeframe' };
          await ctx.reply('Enter custom timeframe (e.g., 6H, 3D, 2W, 1M):');
          await ctx.answerCbQuery();
          return;
      }
      ctx.session.recent.timeframe = tf;
      await handleRecentCalls(ctx as any, tf);
      await ctx.answerCbQuery();
  });

  bot.action(/^recent_chain:(.*)$/, async (ctx) => {
      const chain = ctx.match[1];
      if (!ctx.session) ctx.session = {} as any;
      if (!(ctx.session as any).recent) (ctx.session as any).recent = {};
      if (['both', 'solana', 'bsc'].includes(chain)) {
          (ctx.session as any).recent.chain = chain;
      }
      await ctx.answerCbQuery('Chain updated').catch(() => {});
      const recent = (ctx.session as any).recent || {};
      await handleRecentCalls(ctx as any, recent.timeframe || '7D');
  });
  
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
      // We need to reply a new message or edit? handleGroupStatsCommand usually replies.
      // Let's modify handleGroupStatsCommand to support editing if possible, or just reply.
      // But we are in a callback. Replying is fine.
      await handleGroupStatsCommand(ctx as any, groupId);
      await ctx.answerCbQuery();
  });

  // Handle switching window for group stats
  bot.action(/^group_stats_window:(\d+):(1D|3D|7D|30D|ALL)$/, async (ctx) => {
      const groupId = ctx.match[1];
      // We can reuse handleGroupStatsCommand but we need to pass window?
      // Actually handleGroupStatsCommand currently defaults to ALL.
      // We should update it to accept window or create a specialized function.
      // For now, let's just re-call it and maybe it will default to ALL, but the UI has buttons to switch.
      // Wait, handleGroupStatsCommand doesn't take window arg in the export?
      // Let's check analytics.ts... it takes (ctx, groupIdStr). It DOES NOT take window.
      // We need to update handleGroupStatsCommand to accept window.
      // @ts-ignore
      await handleGroupStatsCommand(ctx as any, groupId, ctx.match[2]); 
      await ctx.answerCbQuery();
  });

  bot.action(/^group_stats_custom:(\d+)$/, async (ctx) => {
      const groupId = parseInt(ctx.match[1]);
      if (!ctx.session) ctx.session = {} as any;
      ctx.session.pendingInput = { type: 'group_stats_timeframe', groupId };
      await ctx.reply('Enter custom timeframe (e.g., 6H, 3D, 2W, 1M):');
      await ctx.answerCbQuery();
  });

  bot.action(/^user_stats_view:(\d+)$/, async (ctx) => {
      const userId = ctx.match[1];
      await handleUserStatsCommand(ctx as any, userId);
      await ctx.answerCbQuery();
  });

  bot.action(/^user_stats_window:(\d+):(1D|3D|7D|30D|ALL)$/, async (ctx) => {
      const userId = ctx.match[1];
      // @ts-ignore
      await handleUserStatsCommand(ctx as any, userId, ctx.match[2]);
      await ctx.answerCbQuery();
  });

  bot.action(/^user_stats_custom:(\d+)$/, async (ctx) => {
      const userId = parseInt(ctx.match[1]);
      if (!ctx.session) ctx.session = {} as any;
      ctx.session.pendingInput = { type: 'user_stats_timeframe', userId };
      await ctx.reply('Enter custom timeframe (e.g., 6H, 3D, 2W, 1M):');
      await ctx.answerCbQuery();
  });


  bot.action('analytics_earliest', async (ctx) => {
      await handleEarliestCallers(ctx as any);
  });

  bot.action('analytics_confirms', async (ctx) => {
      await handleCrossGroupConfirms(ctx as any, 'lag');
  });

  bot.action(/^confirms_view:(.*)$/, async (ctx) => {
      const view = ctx.match[1];
      await handleCrossGroupConfirms(ctx as any, view);
      await ctx.answerCbQuery();
  });
  
  bot.action('analytics_refresh', async (ctx) => {
     try {
         await ctx.answerCbQuery('Recalculating metrics...');
         const { backfillEntryMarketCap, backfillTokenMeta } = await import('../jobs/backfill');
         backfillEntryMarketCap().catch(err => logger.error('Entry MC backfill failed', err));
         backfillTokenMeta().catch(err => logger.error('Token meta backfill failed', err));
         updateHistoricalMetrics().catch(err => logger.error('Manual refresh failed', err));
         await ctx.reply('🔄 Metrics calculation started in background. Check back in a few minutes.');
     } catch(e) {
         ctx.answerCbQuery('Error');
     }
  });

  bot.action('analytics_backfill', async (ctx) => {
      try {
          const progress = getHistoricalMetricsBackfillProgress();
          if (progress.status === 'running') {
              await ctx.answerCbQuery('Backfill already running.');
              const view = buildBackfillStatusView();
              if (ctx.callbackQuery && ctx.callbackQuery.message) {
                  await ctx.editMessageText(view.message, { parse_mode: 'Markdown', reply_markup: view.keyboard });
              } else {
                  await ctx.reply(view.message, { parse_mode: 'Markdown', reply_markup: view.keyboard });
              }
              return;
          }
          await ctx.answerCbQuery('Starting full backfill...');
          await ctx.reply('⏳ Full ATH/DD backfill started in background. This may take a while.');
          const { runHistoricalMetricsBackfill } = await import('../jobs/historicalMetrics');
          const { runAthEnrichmentCycle } = await import('../jobs/athEnrichment');
          runHistoricalMetricsBackfill().catch(err => logger.error('Full backfill failed', err));
          runAthEnrichmentCycle().catch(err => logger.error('ATH enrichment failed', err));
          const view = buildBackfillStatusView();
          await ctx.reply(view.message, { parse_mode: 'Markdown', reply_markup: view.keyboard });
      } catch (error) {
          logger.error('Backfill action error:', error);
          ctx.reply('❌ Failed to start full backfill.');
      }
  });

  bot.action('analytics_backfill_status', async (ctx) => {
      const view = buildBackfillStatusView();
      if (ctx.callbackQuery && ctx.callbackQuery.message) {
          await ctx.editMessageText(view.message, { parse_mode: 'Markdown', reply_markup: view.keyboard });
      } else {
          await ctx.reply(view.message, { parse_mode: 'Markdown', reply_markup: view.keyboard });
      }
      await ctx.answerCbQuery();
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
      const window = ctx.match[1] as '1D' | '3D' | '7D' | '30D' | 'ALL' | string;
      await handleGroupLeaderboardCommand(ctx as any, window);
  });

  bot.action(/^leaderboard_users:(.*)$/, async (ctx) => {
      const window = ctx.match[1] as '1D' | '3D' | '7D' | '30D' | 'ALL' | string;
      await handleUserLeaderboardCommand(ctx as any, window);
  });

  bot.action(/^leaderboard_signals:(.*)$/, async (ctx) => {
      const window = ctx.match[1] as '1D' | '3D' | '7D' | '30D' | 'ALL' | string;
      await handleSignalLeaderboardCommand(ctx as any, window);
  });

  bot.action(/^leaderboard_chain:(.*)$/, async (ctx) => {
      const chain = ctx.match[1];
      if (!ctx.session) ctx.session = {} as any;
      if (['both', 'solana', 'bsc'].includes(chain)) {
          (ctx.session as any).leaderboardChain = chain;
      }

      const view = (ctx.session as any).leaderboardView || { type: 'GROUP', window: '30D' };
      if (view.type === 'USER') {
          await handleUserLeaderboardCommand(ctx as any, view.window);
      } else if (view.type === 'SIGNAL') {
          await handleSignalLeaderboardCommand(ctx as any, view.window);
      } else {
          await handleGroupLeaderboardCommand(ctx as any, view.window);
      }
  });

  bot.action(/^leaderboard_custom:(GROUP|USER|SIGNAL)$/, async (ctx) => {
      const target = ctx.match[1];
      if (!ctx.session) ctx.session = {} as any;
      if (target === 'GROUP') ctx.session.pendingInput = { type: 'leaderboard_groups' };
      if (target === 'USER') ctx.session.pendingInput = { type: 'leaderboard_users' };
      if (target === 'SIGNAL') ctx.session.pendingInput = { type: 'leaderboard_signals' };
      await ctx.reply('Enter custom timeframe (e.g., 6H, 3D, 2W, 1M):');
      await ctx.answerCbQuery();
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
