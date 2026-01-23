import { provider } from '../providers';
import { solana } from '../providers/solana';
import { bitquery } from '../providers/bitquery';
import { logger } from '../utils/logger';
import { calculateRiskScore, getRiskLevel } from './riskScoring';

export interface TokenAnalysis {
  basic: {
    mint: string;
    name: string;
    symbol: string;
    creator: string;
    createdAt: Date | null;
    holderCount: number;
    top10Concentration: number;
    devHoldingsPercent: number;
    hasWebsite: boolean;
    hasTwitter: boolean;
    hasTelegram: boolean;
    riskScore: number;
    riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  };
  deep?: {
    top10Holders: Array<{
      wallet: string;
      percentage: number;
      pumpTokenCount: number;
      tradesLast6h: number;
      isCreator: boolean;
    }>;
    phishyAddresses: Array<{
      wallet: string;
      pattern: 'never_bought' | 'transfer_before_buy';
      totalTransferred: number;
      totalBought: number;
    }>;
    transferStats: {
      totalTransferAddresses: number;
      addressesNoPurchase: number;
      phishyRatio: number;
    };
    liquiditySol: number;
    bondingProgress: number;
    isGraduated: boolean;
    poolCreatedAt?: Date;
    tokenCreatedAt: Date;
    poolBeforeLaunch: boolean;
  };
}


export const getBasicTokenAnalysis = async (mint: string): Promise<TokenAnalysis['basic']> => {
  try {
    const meta = await provider.getTokenMeta(mint);
    const topHolders = await solana.getTopHolders(mint, 10);
    const top10Concentration = topHolders.reduce((sum, h) => sum + (h.percentage || 0), 0);

    const devHoldingsPercent = meta.audit?.devBalancePercentage ?? 0;
    const createdAt = meta.createdAt ?? null;
    const ageHours = createdAt ? (Date.now() - createdAt.getTime()) / (1000 * 60 * 60) : 999;

    const riskScore = calculateRiskScore({
      top10Concentration,
      devHoldingsPercent,
      tokenAgeHours: ageHours
    });
    const riskLevel = getRiskLevel(riskScore);

    return {
      mint,
      name: meta.name || 'Unknown',
      symbol: meta.symbol || 'UNKNOWN',
      creator: 'unknown',
      createdAt,
      holderCount: meta.holderCount ?? 0,
      top10Concentration,
      devHoldingsPercent,
      hasWebsite: !!meta.socialLinks?.website,
      hasTwitter: !!meta.socialLinks?.twitter,
      hasTelegram: !!meta.socialLinks?.telegram,
      riskScore,
      riskLevel
    };
  } catch (err) {
    logger.warn(`Basic token analysis failed for ${mint}: ${err}`);
    return {
      mint,
      name: 'Unknown',
      symbol: 'UNKNOWN',
      creator: 'unknown',
      createdAt: null,
      holderCount: 0,
      top10Concentration: 0,
      devHoldingsPercent: 0,
      hasWebsite: false,
      hasTwitter: false,
      hasTelegram: false,
      riskScore: 0,
      riskLevel: 'LOW'
    };
  }
};

export const getDeepTokenAnalysis = async (_mint: string): Promise<TokenAnalysis['deep'] | null> => {
  try {
    const mint = _mint;
    const meta = await provider.getTokenMeta(mint);
    const topHolders = await solana.getTopHolders(mint, 10);
    const firstBuyers = await bitquery.getFirst100Buyers(mint);

    const top10Holders = topHolders.map(h => ({
      wallet: h.address,
      percentage: h.percentage,
      pumpTokenCount: 0,
      tradesLast6h: 0,
      isCreator: false
    }));

    const transferStats = {
      totalTransferAddresses: 0,
      addressesNoPurchase: 0,
      phishyRatio: 0
    };

    const tokenCreatedAt = meta.createdAt ?? new Date(0);
    const poolCreatedAt = meta.firstPoolCreatedAt ?? undefined;
    const poolBeforeLaunch = !!(poolCreatedAt && tokenCreatedAt && poolCreatedAt < tokenCreatedAt);

    return {
      top10Holders,
      phishyAddresses: [],
      transferStats,
      liquiditySol: meta.liquidity ?? 0,
      bondingProgress: 0,
      isGraduated: !!meta.graduatedAt || !!meta.graduatedPool,
      poolCreatedAt,
      tokenCreatedAt,
      poolBeforeLaunch
    };
  } catch (err) {
    logger.warn(`Deep token analysis failed for ${_mint}: ${err}`);
    return null;
  }
};

