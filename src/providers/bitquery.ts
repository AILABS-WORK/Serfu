import axios from 'axios';
import { logger } from '../utils/logger';

const BITQUERY_ENDPOINT = 'https://streaming.bitquery.io/eap'; // v2 API Endpoint
const API_TOKEN = process.env.BITQUERY_API_TOKEN || '';

export interface TokenPnL {
  symbol: string;
  name: string;
  mint: string;
  totalBought: number;
  totalBoughtUSD: number;
  totalSold: number;
  totalSoldUSD: number;
  totalVolumeUSD: number;
  tradeCount: number;
  pnl: number;
  roi: number;
}

export class BitqueryProvider {
  private token: string;

  constructor(token?: string) {
    this.token = token || API_TOKEN;
  }

  async getWalletPnL(address: string, limit: number = 20): Promise<TokenPnL[]> {
    if (!this.token) {
      logger.warn('Bitquery API token not found. Skipping PnL analysis.');
      return [];
    }

    const query = `
      query AddressPnLHistory($wallet: String!, $limit: Int!) {
        Solana {
          DEXTradeByTokens(
            where: {
              Transaction: {Result: {Success: true}}, 
              any: [
                {Trade: {Buy: {Account: {Address: {is: $wallet}}}}},
                {Trade: {Buy: {Account: {Token: {Owner: {is: $wallet}}}}}},
                {Trade: {Sell: {Account: {Address: {is: $wallet}}}}},
                {Trade: {Sell: {Account: {Token: {Owner: {is: $wallet}}}}}}
              ]
            }
            orderBy: {descendingByField: "volumeUsd"}
            limit: {count: $limit}
          ) {
            Trade {
              Currency {
                Symbol
                Name
                MintAddress
              }
            }
            # Buy metrics
            totalBought: sum(
              of: Trade_Amount
              if: {Trade: {Side: {Type: {is: buy}}}}
            )
            totalBoughtUSD: sum(
              of: Trade_Side_AmountInUSD
              if: {Trade: {Side: {Type: {is: buy}}}}
            )
            # Sell metrics  
            totalSold: sum(
              of: Trade_Amount
              if: {Trade: {Side: {Type: {is: sell}}}}
            )
            totalSoldUSD: sum(
              of: Trade_Side_AmountInUSD
              if: {Trade: {Side: {Type: {is: sell}}}}
            )
            # Overall metrics
            totalVolumeUSD: sum(of: Trade_Side_AmountInUSD)
            totalTrades: count
          }
        }
      }
    `;

    try {
      const response = await axios.post(
        BITQUERY_ENDPOINT,
        {
          query,
          variables: {
            wallet: address,
            limit
          }
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.token}`
          }
        }
      );

      if (response.data.errors) {
        logger.error(`Bitquery errors for ${address}:`, response.data.errors);
        return [];
      }

      const trades = response.data?.data?.Solana?.DEXTradeByTokens || [];

      return trades.map((t: any) => {
        const boughtUSD = parseFloat(t.totalBoughtUSD || '0');
        const soldUSD = parseFloat(t.totalSoldUSD || '0');
        const pnl = soldUSD - boughtUSD;
        const roi = boughtUSD > 0 ? (pnl / boughtUSD) * 100 : 0;

        return {
          symbol: t.Trade?.Currency?.Symbol || 'UNK',
          name: t.Trade?.Currency?.Name || 'Unknown',
          mint: t.Trade?.Currency?.MintAddress || '',
          totalBought: parseFloat(t.totalBought || '0'),
          totalBoughtUSD: boughtUSD,
          totalSold: parseFloat(t.totalSold || '0'),
          totalSoldUSD: soldUSD,
          totalVolumeUSD: parseFloat(t.totalVolumeUSD || '0'),
          tradeCount: parseInt(t.totalTrades || '0'),
          pnl,
          roi
        };
      });

    } catch (error) {
      logger.error(`Error fetching Bitquery PnL for ${address}:`, error);
      return [];
    }
  }
}

export const bitquery = new BitqueryProvider();

