import { logger } from '../utils/logger';
import axios from 'axios';

const BITQUERY_ENDPOINT = 'https://streaming.bitquery.io/eap'; // v2 endpoint usually

export interface BitqueryTradeStats {
  token: {
    symbol: string;
    name: string;
    mint: string;
  };
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
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async getWalletPnL(walletAddress: string): Promise<BitqueryTradeStats[]> {
    const query = `
      query AddressPnLHistory($wallet: String!) {
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
            limit: {count: 50} 
          ) {
            Trade {
              Currency {
                Symbol
                Name
                MintAddress
              }
              Side {
                Currency {
                  Symbol
                  Name
                  MintAddress
                }
              }
            }
            totalBought: sum(of: Trade_Amount, if: {Trade: {Side: {Type: {is: buy}}}})
            totalBoughtUSD: sum(of: Trade_Side_AmountInUSD, if: {Trade: {Side: {Type: {is: buy}}}})
            totalSold: sum(of: Trade_Amount, if: {Trade: {Side: {Type: {is: sell}}}})
            totalSoldUSD: sum(of: Trade_Side_AmountInUSD, if: {Trade: {Side: {Type: {is: sell}}}})
            totalVolumeUSD: sum(of: Trade_Side_AmountInUSD)
            tradeCount: count
          }
        }
      }
    `;

    try {
      const response = await axios.post(
        BITQUERY_ENDPOINT,
        {
          query,
          variables: { wallet: walletAddress },
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`,
          },
        }
      );

      if (response.data.errors) {
        logger.error('Bitquery GraphQL errors:', response.data.errors);
        return [];
      }

      const results = response.data.data?.Solana?.DEXTradeByTokens || [];
      
      return results.map((item: any) => {
        const currency = item.Trade.Currency;
        const boughtUSD = item.totalBoughtUSD || 0;
        const soldUSD = item.totalSoldUSD || 0;
        const pnl = soldUSD - boughtUSD;
        // Simple ROI: (Profit / Cost) * 100. If cost is 0 (airdrop/transfer), max it out or handle gracefully.
        const roi = boughtUSD > 0 ? (pnl / boughtUSD) * 100 : (soldUSD > 0 ? 9999 : 0);

        return {
          token: {
            symbol: currency.Symbol || 'UNK',
            name: currency.Name || 'Unknown',
            mint: currency.MintAddress,
          },
          totalBought: item.totalBought || 0,
          totalBoughtUSD: boughtUSD,
          totalSold: item.totalSold || 0,
          totalSoldUSD: soldUSD,
          totalVolumeUSD: item.totalVolumeUSD || 0,
          tradeCount: item.tradeCount || 0,
          pnl,
          roi,
        };
      }).filter((s: BitqueryTradeStats) => s.totalVolumeUSD > 100); // Filter dust

    } catch (error) {
      logger.error(`Error fetching Bitquery PnL for ${walletAddress}:`, error);
      return [];
    }
  }
}

export const bitquery = new BitqueryProvider(process.env.BIT_QUERY_API_KEY || '');

