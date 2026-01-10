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
    type: 'BUY' | 'SELL';
    amountUsd: number;
    date: string;
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

      // B. Analyze History (Good Trades)
      const history = await heliusProvider.getWalletHistory(h.address, 50); // Last 50 swaps
      const bestTrades: any[] = [];
      
      for (const tx of history) {
          // Look for large SWAP OUT (Sell) -> "Good Exit"
          // We want to see if they sold a token for > $10k
          // Helius enriched tx structure: tokenTransfers array
          
          if (tx.type === 'SWAP' && tx.tokenTransfers) {
              const transfers = tx.tokenTransfers;
              // Usually 2 transfers: Token -> User (Buy) or User -> Token (Sell)
              // If User is sender of Token A and receiver of SOL/USDC -> Sell
              
              // Simplification: Check if they received > $10k of SOL/USDC
              const received = transfers.find((t: any) => t.toUserAccount === h.address);
              const sent = transfers.find((t: any) => t.fromUserAccount === h.address);
              
              if (received && sent) {
                  // Check if received is SOL or Stable
                  const isStableExit = ['USDC', 'USDT'].includes(received.tokenAmount?.symbol);
                  const isSolExit = received.mint === 'So11111111111111111111111111111111111111112'; // Approximate check
                  
                  if (isStableExit || isSolExit) {
                      // It's a SELL
                      const val = received.tokenAmount?.amount * (received.tokenAmount?.price_per_token || 0); // Need price... Helius enriched usually has it?
                      // If price not available, we can't estimate value easily without historical price. 
                      // Helius enriched SOMETIMES has raw amount. 
                      // Assume we might not have historical USD value perfectly.
                      // But nativeTransfer (SOL) has amount.
                  }
              }

              // Use nativeTransfers for SOL
              if (tx.nativeTransfers) {
                  const solReceived = tx.nativeTransfers.find((t: any) => t.toUserAccount === h.address);
                  if (solReceived) {
                      const amountSol = solReceived.amount / 1e9;
                      // Assume roughly $150/SOL for heuristic or 0
                      const val = amountSol * 150; 
                      if (val > 10000) { // Sold for > $10k
                           // Check what they sold (token transfer out)
                           const soldToken = tx.tokenTransfers?.find((t: any) => t.fromUserAccount === h.address);
                           if (soldToken) {
                               bestTrades.push({
                                   token: soldToken.mint, // Or symbol if available
                                   type: 'SELL',
                                   amountUsd: val,
                                   date: new Date(tx.timestamp * 1000).toLocaleDateString()
                               });
                           }
                      }
                  }
              }
          }
      }


      summaries.push({
        address: h.address,
        rank: h.rank,
        percentage: h.percentage,
        solBalance,
        notableHoldings: notable.slice(0, 3), 
        bestTrades: bestTrades.slice(0, 2), // Show top 2 big exits
        totalValueUsd: totalValue
      });
    }

    return summaries;

  } catch (error) {
    logger.error(`Error in deep holder analysis for ${mint}:`, error);
    return [];
  }
};
