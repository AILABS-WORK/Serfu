import { prisma } from '../db';
import { solana, TokenHolderInfo } from '../providers/solana';
import { logger } from '../utils/logger';

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

