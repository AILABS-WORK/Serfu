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
      holders.map(async (h) => {
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
    const holderIds = holderRecords.map((h) => h.id);

    // Find other signals where these holders were top holders
    const matches = await prisma.signalTopHolder.findMany({
      where: {
        holderId: { in: holderIds },
        signalId: { not: signalId }, // Exclude current
        signal: {
          metrics: {
            athMultiple: { gte: 5 }, // "Crazy 50x" threshold (start with 5x or 10x for testing)
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
      // Find the rank of this holder in the *current* signal
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

// --- NEW: Detailed Portfolio Analysis ---

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
}

export const getDeepHolderAnalysis = async (mint: string): Promise<PortfolioSummary[]> => {
  try {
    // 1. Get Top Holders (Top 10)
    const holders = await solana.getTopHolders(mint, 10); 
    if (holders.length === 0) return [];

    const summaries: PortfolioSummary[] = [];
    const heliusProvider = provider instanceof HeliusProvider ? provider : new HeliusProvider(process.env.HELIUS_API_KEY || '');

    for (const h of holders) {
      // A. Analyze Assets
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

        // Filter notable: Value > $5000 OR Known Bluechips (> $1000)
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

      // B. Analyze History (Good Trades / PnL)
      const history = await heliusProvider.getWalletHistory(h.address, 100); // Last 100 swaps
      
      const tokenStats = new Map<string, { 
        symbol: string, 
        buyUsd: number, 
        sellUsd: number, 
        lastDate: number 
      }>();

      for (const tx of history) {
        if (tx.type === 'SWAP' && tx.tokenTransfers && tx.timestamp) {
            const transfers = tx.tokenTransfers;
            // Determine if BUY or SELL relative to the User (h.address)
            
            // Check for outgoing token (Sell)
            const sent = transfers.find((t: any) => t.fromUserAccount === h.address);
            // Check for incoming token (Buy)
            const received = transfers.find((t: any) => t.toUserAccount === h.address);

            // Estimate Value in USD
            // Priority 1: Check native SOL transfer (if involved)
            // Priority 2: Check stablecoin transfer
            let usdValue = 0;
            
            if (tx.nativeTransfers) {
                const solTx = tx.nativeTransfers.find((t: any) => t.fromUserAccount === h.address || t.toUserAccount === h.address);
                if (solTx) {
                    usdValue = (solTx.amount / 1e9) * 150; // Approx $150/SOL
                }
            }

            // Refine USD Value if stablecoin involved
            if (sent && ['USDC', 'USDT'].includes(sent.tokenAmount?.symbol)) {
                usdValue = sent.tokenAmount?.amount || 0;
            } else if (received && ['USDC', 'USDT'].includes(received.tokenAmount?.symbol)) {
                usdValue = received.tokenAmount?.amount || 0;
            }

            if (usdValue === 0) continue; // Can't estimate PnL without USD anchor

            // Case 1: Selling Token A for SOL/Stable
            if (sent && !['USDC', 'USDT', 'SOL'].includes(sent.tokenAmount?.symbol || '')) {
                // Selling 'sent.mint'
                const mint = sent.mint;
                const stats = tokenStats.get(mint) || { symbol: sent.tokenAmount?.symbol || 'UNK', buyUsd: 0, sellUsd: 0, lastDate: 0 };
                stats.sellUsd += usdValue;
                if (tx.timestamp > stats.lastDate) stats.lastDate = tx.timestamp;
                tokenStats.set(mint, stats);
            }

            // Case 2: Buying Token B with SOL/Stable
            if (received && !['USDC', 'USDT', 'SOL'].includes(received.tokenAmount?.symbol || '')) {
                // Buying 'received.mint'
                const mint = received.mint;
                const stats = tokenStats.get(mint) || { symbol: received.tokenAmount?.symbol || 'UNK', buyUsd: 0, sellUsd: 0, lastDate: 0 };
                stats.buyUsd += usdValue;
                if (tx.timestamp > stats.lastDate) stats.lastDate = tx.timestamp;
                tokenStats.set(mint, stats);
            }
        }
      }

      // Convert Map to Array and Sort by Profit
      const trades: any[] = [];
      tokenStats.forEach((stats, mint) => {
          if (stats.sellUsd > 1000) { // Only consider significant exits > $1k
             const pnl = stats.sellUsd - stats.buyUsd;
             const pnlPercent = stats.buyUsd > 0 ? (pnl / stats.buyUsd) * 100 : 0;
             
             // We want "Sold High, Bought Low" => High PnL
             if (pnl > 500 || (stats.buyUsd > 0 && stats.sellUsd > stats.buyUsd * 2)) {
                 trades.push({
                     token: mint,
                     symbol: stats.symbol,
                     buyUsd: stats.buyUsd,
                     sellUsd: stats.sellUsd,
                     pnl,
                     pnlPercent,
                     lastTradeDate: new Date(stats.lastDate * 1000).toLocaleDateString()
                 });
             }
          }
      });

      // Sort by Realized PnL (desc)
      trades.sort((a, b) => b.pnl - a.pnl);

      summaries.push({
        address: h.address,
        rank: h.rank,
        percentage: h.percentage,
        solBalance,
        notableHoldings: notable.slice(0, 3), 
        bestTrades: trades.slice(0, 3), // Show top 3 best realized trades
        totalValueUsd: totalValue
      });
    }

    return summaries;

  } catch (error) {
    logger.error(`Error in deep holder analysis for ${mint}:`, error);
    return [];
  }
};
