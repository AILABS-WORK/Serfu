import { getWalletCrossSignalPerformance, WalletSignalPerformance } from './walletIntelligence';

export const findSmartMoney = async (limit: number = 20): Promise<WalletSignalPerformance[]> => {
  const wallets = await getWalletCrossSignalPerformance();
  return wallets.slice(0, limit);
};

