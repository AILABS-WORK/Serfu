import axios from 'axios';
import { logger } from '../utils/logger';

const BITQUERY_ENDPOINT = 'https://streaming.bitquery.io/eap';

export interface FourMemeTrader {
  wallet: string;
  buyVolume: number;
  sellVolume: number;
  volumeUsd: number;
}

export class FourMemeProvider {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async getBondingProgress(tokenAddress: string, balance: number): Promise<number> {
    const reserved = 200_000_000;
    const initialReal = 800_000_000;
    const leftTokens = balance - reserved;
    return 100 - ((leftTokens * 100) / initialReal);
  }

  async getNearGraduationTokens(): Promise<string[]> {
    return [];
  }

  async getDevInfo(_tokenAddress: string): Promise<{ devAddress: string; holdingsPercent: number }> {
    return { devAddress: 'unknown', holdingsPercent: 0 };
  }

  async hasMigrated(_tokenAddress: string): Promise<{ migrated: boolean; to?: 'pancakeswap'; txHash?: string }> {
    return { migrated: false };
  }

  async getATH(tokenAddress: string): Promise<number> {
    const query = `
      query tradingView($network: evm_network, $dataset: dataset_arg_enum, $token: String) {
        EVM(network: $network, dataset: $dataset) {
          DEXTradeByTokens(
            limit: { count: 1 }
            where: {
              TransactionStatus: { Success: true }
              Trade: {
                Side: { Currency: { SmartContract: { is: "0x" } } }
                Currency: { SmartContract: { is: $token } }
              }
            }
          ) {
            max: quantile(of: Trade_PriceInUSD, level: 0.98)
          }
        }
      }
    `;

    try {
      const response = await axios.post(
        BITQUERY_ENDPOINT,
        { query, variables: { network: 'bsc', dataset: 'combined', token: tokenAddress } },
        { headers: { 'Authorization': `Bearer ${this.apiKey}` } }
      );
      const row = response.data?.data?.EVM?.DEXTradeByTokens?.[0];
      return Number(row?.max || 0);
    } catch (err) {
      logger.warn(`FourMeme ATH failed for ${tokenAddress}: ${err}`);
      return 0;
    }
  }

  async getTopTraders(tokenAddress: string): Promise<FourMemeTrader[]> {
    const query = `
      query topTraders($network: evm_network, $token: String) {
        EVM(network: $network, dataset: combined) {
          DEXTradeByTokens(
            orderBy: {descendingByField: "volumeUsd"}
            limit: {count: 10}
            where: {Trade: {Currency: {SmartContract: {is: $token}}, Dex: {ProtocolName: {is: "fourmeme_v1"}}}}
          ) {
            Trade {
              Buyer
            }
            buyVolume: sum(of: Trade_Amount, if: {Trade: {Side: {Type: {is: buy}}}})
            sellVolume: sum(of: Trade_Amount, if: {Trade: {Side: {Type: {is: sell}}}})
            volumeUsd: sum(of: Trade_Side_AmountInUSD)
          }
        }
      }
    `;

    try {
      const response = await axios.post(
        BITQUERY_ENDPOINT,
        { query, variables: { network: 'bsc', token: tokenAddress } },
        { headers: { 'Authorization': `Bearer ${this.apiKey}` } }
      );
      const rows = response.data?.data?.EVM?.DEXTradeByTokens || [];
      return rows.map((row: any) => ({
        wallet: row?.Trade?.Buyer || 'unknown',
        buyVolume: Number(row?.buyVolume || 0),
        sellVolume: Number(row?.sellVolume || 0),
        volumeUsd: Number(row?.volumeUsd || 0)
      })).filter((t: FourMemeTrader) => t.wallet !== 'unknown');
    } catch (err) {
      logger.warn(`FourMeme top traders failed for ${tokenAddress}: ${err}`);
      return [];
    }
  }
}

export const fourMeme = new FourMemeProvider(process.env.BIT_QUERY_API_KEY || '');

