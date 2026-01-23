import { prisma } from '../db';
import { bitquery } from '../providers/bitquery';
import { logger } from '../utils/logger';

export interface WalletSignalPerformance {
  wallet: string;
  signalAppearances: number;
  winningSignals: number;
  winRate: number;
  avgMultiple: number;
  earlyBuyerCount: number;
  avgEntryRank: number;
}

export const getWalletCrossSignalPerformance = async (): Promise<WalletSignalPerformance[]> => {
  const winningSignals = await prisma.signal.findMany({
    where: { metrics: { athMultiple: { gte: 2 } } },
    include: { metrics: true }
  });

  const walletStats = new Map<string, { signalIds: number[]; multiples: number[]; ranks: number[] }>();

  for (const sig of winningSignals) {
    const buyers = await bitquery.getFirst100Buyers(sig.mint);
    buyers.forEach((buyer, idx) => {
      const existing = walletStats.get(buyer.wallet) || { signalIds: [], multiples: [], ranks: [] };
      existing.signalIds.push(sig.id);
      existing.multiples.push(sig.metrics?.athMultiple || 0);
      existing.ranks.push(idx + 1);
      walletStats.set(buyer.wallet, existing);
    });
  }

  const results: WalletSignalPerformance[] = [];
  for (const [wallet, data] of walletStats.entries()) {
    const uniqueSignals = Array.from(new Set(data.signalIds));
    const avgMultiple = data.multiples.length > 0 ? data.multiples.reduce((a, b) => a + b, 0) / data.multiples.length : 0;
    const avgEntryRank = data.ranks.length > 0 ? data.ranks.reduce((a, b) => a + b, 0) / data.ranks.length : 0;
    const winningSignalsCount = uniqueSignals.length;

    results.push({
      wallet,
      signalAppearances: uniqueSignals.length,
      winningSignals: winningSignalsCount,
      winRate: uniqueSignals.length > 0 ? winningSignalsCount / uniqueSignals.length : 0,
      avgMultiple,
      earlyBuyerCount: data.ranks.length,
      avgEntryRank
    });
  }

  logger.info(`[WalletIntelligence] Computed ${results.length} wallet performance entries`);
  return results.sort((a, b) => b.winRate - a.winRate);
};

