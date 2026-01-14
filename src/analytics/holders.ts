import { prisma } from '../db';
import { solana, TokenHolderInfo } from '../providers/solana';
import { logger } from '../utils/logger';
import { provider } from '../providers';
import { HeliusProvider } from '../providers/helius';

export interface WhaleAlert {
  holderAddress: string;
  matchedSignalId: number;
  matchedSignalName: string;
  matchedAthMultiple: number;
  rankInCurrent: number;
}

export const analyzeHolders = async (signalId: number, mint: string): Promise<WhaleAlert[]> => {
  try {
    // 1. Fetch Top Holders from Solana RPC
    const holders = await solana.getTopHolders(mint, 10);
    if (holders.length === 0) return [];

    // 2. Store Holders in DB
    const holderRecords = await Promise.all(
      holders.map(async (h: TokenHolderInfo) => {
        // Create or get Holder
        const holder = await prisma.tokenHolder.upsert({
          where: { address: h.address },
          create: { address: h.address },
          update: {},
        });

        // Link to Signal
        await prisma.signalTopHolder.upsert({
          where: {
            signalId_holderId: {
              signalId,
              holderId: holder.id,
            },
          },
          create: {
            signalId,
            holderId: holder.id,
            rank: h.rank,
            percentage: h.percentage,
            amount: h.amount,
          },
          update: {
            rank: h.rank,
            percentage: h.percentage,
            amount: h.amount,
          },
        });

        return holder;
      })
    );

    // 3. Cross-Reference: Find if these holders are present in HIGH ROI signals
    const alerts: WhaleAlert[] = [];
    const holderIds = holderRecords.map((h: any) => h.id);

    // Find other signals where these holders were top holders
    const matches = await prisma.signalTopHolder.findMany({
      where: {
        holderId: { in: holderIds },
        signalId: { not: signalId }, // Exclude current
        signal: {
          metrics: {
            athMultiple: { gte: 5 }, // "Crazy 50x" threshold
          },
        },
      },
      include: {
        signal: {
          include: { metrics: true },
        },
        holder: true,
      },
    });

    // Format alerts
    for (const match of matches) {
      const currentRank = holders.find(h => h.address === match.holder.address)?.rank || 0;
      
      alerts.push({
        holderAddress: match.holder.address,
        matchedSignalId: match.signalId,
        matchedSignalName: match.signal.name || match.signal.mint,
        matchedAthMultiple: match.signal.metrics?.athMultiple || 0,
        rankInCurrent: currentRank
      });
    }

    return alerts;

  } catch (error) {
    logger.error(`Error analyzing holders for ${mint}:`, error);
    return [];
  }
};

import { bitquery } from '../providers/bitquery';

// ... existing imports ...

// --- NEW: Detailed Portfolio Analysis (Helius + Bitquery) ---

export interface PortfolioSummary {
  address: string;
  rank: number;
  percentage: number;
  solBalance: number;
  notableHoldings: {
    symbol: string;
    mint: string;
    amount: number;
    valueUsd?: number;
  }[];
  bestTrades: {
    token: string;
    symbol: string;
    buyUsd: number;
    sellUsd: number;
    pnl: number;
    pnlPercent: number;
    lastTradeDate: string;
  }[];
  totalValueUsd?: number;
  winRate?: number; // Win rate from last 100 transactions
  totalTrades?: number; // Total trades analyzed
  topTrade?: {
    symbol: string;
    pnl: number;
    pnlPercent: number;
  }; // Best single trade
}

export const getDeepHolderAnalysis = async (mint: string, mode: 'standard' | 'deep' = 'standard'): Promise<PortfolioSummary[]> => {
  try {
    // 1. Get Top Holders (Top 10)
    const holders = await solana.getTopHolders(mint, 10); 
    if (holders.length === 0) return [];

    const summaries: PortfolioSummary[] = [];
    // Ensure we use Helius provider (or instantiate one)
    const heliusProvider = provider instanceof HeliusProvider ? provider : new HeliusProvider(process.env.HELIUS_API_KEY || '');
    const useBitquery = !!process.env.BIT_QUERY_API_KEY;

    for (const h of holders) {
      // A. Analyze Assets (Current Holdings)
      const assets = await heliusProvider.getWalletAssets(h.address);
      
      let solBalance = 0;
      const notable: any[] = [];
      let totalValue = 0;

      for (const asset of assets) {
        const info = asset.token_info || {};
        const priceInfo = info.price_info || {};
        const symbol = asset.content?.metadata?.symbol || 'UNK';
        
        if (symbol === 'SOL') {
            solBalance = (asset.native_balance?.lamports || 0) / 1e9;
            totalValue += (priceInfo.price_per_token || 0) * solBalance;
            continue;
        }

        const decimals = info.decimals || 0;
        const amount = (info.balance || 0) / Math.pow(10, decimals);
        const price = priceInfo.price_per_token || 0;
        const value = amount * price;

        if (value > 0) totalValue += value;

        const isBluechip = ['USDC', 'USDT', 'BONK', 'WIF', 'JUP', 'RAY', 'POPCAT'].includes(symbol);
        
        if (value > 5000 || (isBluechip && value > 1000)) {
          notable.push({
            symbol,
            mint: asset.id,
            amount,
            valueUsd: value
          });
        }
      }

      notable.sort((a, b) => (b.valueUsd || 0) - (a.valueUsd || 0));

      // B. Analyze History (Switch to Bitquery if available)
      let bestTrades: any[] = [];

      // Bitquery is powerful but complex to integrate ad-hoc without existing robust client. 
      // Helius Enriched Transactions is native and we have the provider.
      // We will stick to Helius Enriched Transactions as per plan.
      
      const txLimit = mode === 'deep' ? 1000 : 100;
      const history = await heliusProvider.getWalletHistory(h.address, txLimit);
      
      const tokenStats = new Map<string, { 
        symbol: string, 
        buyUsd: number, 
        sellUsd: number, 
        lastDate: number 
      }>();

      for (const tx of history) {
        if (tx.type === 'SWAP' && tx.tokenTransfers && tx.timestamp) {
            const transfers = tx.tokenTransfers;
            
            // Check for outgoing token (Sell) - User is SENDER
            const sent = transfers.find((t: any) => t.fromUserAccount === h.address);
            // Check for incoming token (Buy) - User is RECEIVER
            const received = transfers.find((t: any) => t.toUserAccount === h.address);

            // Estimate USD Value of the SWAP
            let usdValue = 0;
            
            // 1. Did they pay/receive SOL?
            if (tx.nativeTransfers) {
                const solTx = tx.nativeTransfers.find((t: any) => t.fromUserAccount === h.address || t.toUserAccount === h.address);
                if (solTx) {
                    usdValue = (solTx.amount / 1e9) * 150; // Approx $150/SOL heuristic
                }
            }

            // 2. Did they pay/receive Stablecoin? (More accurate)
            if (sent && ['USDC', 'USDT'].includes(sent.tokenAmount?.symbol)) {
                usdValue = sent.tokenAmount?.amount || 0;
            } else if (received && ['USDC', 'USDT'].includes(received.tokenAmount?.symbol)) {
                usdValue = received.tokenAmount?.amount || 0;
            }

            if (usdValue === 0) continue; 

            // LOGIC:
            // Buying Token X: They SENT SOL/USDC and RECEIVED Token X
            if (received && !['USDC', 'USDT', 'SOL'].includes(received.tokenAmount?.symbol || '')) {
                const mint = received.mint;
                const stats = tokenStats.get(mint) || { symbol: received.tokenAmount?.symbol || 'UNK', buyUsd: 0, sellUsd: 0, lastDate: 0 };
                stats.buyUsd += usdValue;
                if (tx.timestamp > stats.lastDate) stats.lastDate = tx.timestamp;
                tokenStats.set(mint, stats);
            }

            // Selling Token X: They SENT Token X and RECEIVED SOL/USDC
            if (sent && !['USDC', 'USDT', 'SOL'].includes(sent.tokenAmount?.symbol || '')) {
                const mint = sent.mint;
                const stats = tokenStats.get(mint) || { symbol: sent.tokenAmount?.symbol || 'UNK', buyUsd: 0, sellUsd: 0, lastDate: 0 };
                stats.sellUsd += usdValue;
                if (tx.timestamp > stats.lastDate) stats.lastDate = tx.timestamp;
                tokenStats.set(mint, stats);
            }
        }
      }

      // Convert Map to Array and Sort by Profit
      tokenStats.forEach((stats, mint) => {
          // We look for significant exits > $1k
          if (stats.sellUsd > 1000) { 
             const pnl = stats.sellUsd - stats.buyUsd;
             const pnlPercent = stats.buyUsd > 0 ? (pnl / stats.buyUsd) * 100 : 0;
             
             // Filter: Profitable OR High Volume Exit (even if entry unknown/partial)
             // If buyUsd is 0 (entry was older than 100 txs), we treat sellUsd as "Cashed Out Amount"
             // Use heuristic: PnL > $500 OR (Buy known & >2x) OR (Entry unknown & Sell > $5k)
             
             if (pnl > 500 || (stats.buyUsd > 0 && stats.sellUsd > stats.buyUsd * 2) || (stats.buyUsd === 0 && stats.sellUsd > 5000)) {
                 bestTrades.push({
                     token: mint,
                     symbol: stats.symbol,
                     buyUsd: stats.buyUsd, // Might be 0 if entry outside window
                     sellUsd: stats.sellUsd,
                     pnl: stats.buyUsd > 0 ? pnl : stats.sellUsd, // If unknown entry, PnL ~ Sell Amount (heuristic)
                     pnlPercent: stats.buyUsd > 0 ? pnlPercent : 999, // 999% indicates "Moonbag / Old Entry"
                     lastTradeDate: new Date(stats.lastDate * 1000).toLocaleDateString()
                 });
             }
          }
      });

      bestTrades.sort((a, b) => b.pnl - a.pnl);

      // Calculate Win Rate from trades
      const closedTrades = Array.from(tokenStats.entries())
        .filter(([_, stats]: [string, any]) => stats.buyUsd > 0 && stats.sellUsd > 0)
        .map(([_, stats]: [string, any]) => ({
          pnl: stats.sellUsd - stats.buyUsd,
          pnlPercent: (stats.sellUsd - stats.buyUsd) / stats.buyUsd * 100
        }));
      
      const wins = closedTrades.filter((t: any) => t.pnl > 0).length;
      const winRate = closedTrades.length > 0 ? wins / closedTrades.length : 0;
      
      // Find top trade
      const topTrade = bestTrades.length > 0 ? {
        symbol: bestTrades[0].symbol,
        pnl: bestTrades[0].pnl,
        pnlPercent: bestTrades[0].pnlPercent
      } : undefined;

      summaries.push({
        address: h.address,
        rank: h.rank,
        percentage: h.percentage,
        solBalance,
        notableHoldings: notable.slice(0, 3), 
        bestTrades: bestTrades.slice(0, 3), 
        totalValueUsd: totalValue,
        winRate,
        totalTrades: closedTrades.length,
        topTrade
      });
    }

    return summaries;

  } catch (error) {
    logger.error(`Error in deep holder analysis for ${mint}:`, error);
    return [];
  }
};
