import { Connection, PublicKey } from '@solana/web3.js';
import { logger } from '../utils/logger';

const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

export interface TokenHolderInfo {
  address: string;
  amount: number;
  percentage: number;
  rank: number;
}

export class SolanaProvider {
  private connection: Connection;

  constructor() {
    this.connection = new Connection(RPC_URL);
  }

  async getTopHolders(mintAddress: string, limit: number = 10): Promise<TokenHolderInfo[]> {
    try {
      const mint = new PublicKey(mintAddress);
      
      // 1. Get Token Supply
      const supplyInfo = await this.connection.getTokenSupply(mint);
      const totalSupply = supplyInfo.value.uiAmount || 0;
      
      if (totalSupply === 0) return [];

      // 2. Get Largest Accounts
      const largestAccounts = await this.connection.getTokenLargestAccounts(mint);
      
      if (!largestAccounts.value || largestAccounts.value.length === 0) return [];

      // 3. Process top N accounts
      // Note: getTokenLargestAccounts returns Token Accounts (ATAs), not Owner Wallets.
      // We need to fetch the owner for each ATA.
      
      const topAccounts = largestAccounts.value.slice(0, limit);
      const results: TokenHolderInfo[] = [];

      // Fetch account info to get owners (in batches if needed, but 10 is small)
      // Actually we need `getParsedAccountInfo` or parse the data manually.
      // `getMultipleAccountsInfo` is efficient.
      const accountKeys = topAccounts.map((acc: any) => acc.address);
      const accountsInfo = await this.connection.getMultipleAccountsInfo(accountKeys);

      for (let i = 0; i < topAccounts.length; i++) {
        const acc = topAccounts[i];
        const info = accountsInfo[i];
        
        let ownerAddress = acc.address.toString(); // Default to ATA if parsing fails (rare)

        if (info && info.data) {
            // Check if it's a Token Account
            // We can manually parse or use a library helper.
            // Standard SPL Token Layout: Mint (32), Owner (32), Amount (8), ...
            // Owner is at offset 32.
            if (info.data.length >= 64) {
                const owner = new PublicKey(info.data.slice(32, 64));
                ownerAddress = owner.toString();
            }
        }

        const percentage = (acc.uiAmount || 0) / totalSupply * 100;

        results.push({
          address: ownerAddress,
          amount: acc.uiAmount || 0,
          percentage,
          rank: i + 1
        });
      }

      return results;

    } catch (error) {
      logger.error(`Error fetching top holders for ${mintAddress}:`, error);
      return [];
    }
  }
}

export const solana = new SolanaProvider();


