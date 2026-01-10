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
  totalValueUsd?: number;
}

export const getDeepHolderAnalysis = async (mint: string): Promise<PortfolioSummary[]> => {
  try {
    // 1. Get Top Holders
    const holders = await solana.getTopHolders(mint, 5); // Analyze top 5
    if (holders.length === 0) return [];

    // 2. Analyze each holder's portfolio using Helius
    const summaries: PortfolioSummary[] = [];

    // Use Helius provider directly (cast to access specific method if needed, or use public interface if updated)
    // Assuming provider is HeliusProvider or we instantiate one
    const heliusProvider = provider instanceof HeliusProvider ? provider : new HeliusProvider(process.env.HELIUS_API_KEY || '');

    for (const h of holders) {
      const assets = await heliusProvider.getWalletAssets(h.address);
      
      let solBalance = 0;
      const notable: any[] = [];
      let totalValue = 0;

      for (const asset of assets) {
        // Native SOL
        if (asset.id === 'So11111111111111111111111111111111111111112' || asset.interface === 'ProgrammableNFT') { 
             // Helius returns native SOL as specific ID or inside native_balance field
        }
        
        // Check native balance from response (usually separate field in some RPCs, but Helius DAS might include wrapped SOL)
        // DAS 'native_balance' field on the owner object? No, getAssetsByOwner returns list of assets.
        // Helius getAssetsByOwner usually includes an item for Native SOL if showNativeBalance: true.
        
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

        // Filter notable: Value > $500 OR Known Bluechips
        const isBluechip = ['USDC', 'USDT', 'BONK', 'WIF', 'JUP', 'RAY', 'POPCAT'].includes(symbol);
        
        if (value > 500 || (isBluechip && value > 100)) {
          notable.push({
            symbol,
            mint: asset.id,
            amount,
            valueUsd: value
          });
        }
      }

      // Sort notable by value
      notable.sort((a, b) => (b.valueUsd || 0) - (a.valueUsd || 0));

      summaries.push({
        address: h.address,
        rank: h.rank,
        percentage: h.percentage,
        solBalance,
        notableHoldings: notable.slice(0, 3), // Top 3 holdings
        totalValueUsd: totalValue
      });
    }

    return summaries;

  } catch (error) {
    logger.error(`Error in deep holder analysis for ${mint}:`, error);
    return [];
  }
};
