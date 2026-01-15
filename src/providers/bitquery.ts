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

export interface BitqueryOHLCV {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export class BitqueryProvider {
  private apiKey: string;
  private disabled: boolean = false;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async getWalletPnL(walletAddress: string): Promise<BitqueryTradeStats[]> {
    if (!this.apiKey || this.disabled) return [];
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

    } catch (error: any) {
      if (error?.response?.status === 401) {
        this.disabled = true;
        logger.warn('Bitquery unauthorized (401). Disabling Bitquery for this runtime.');
        return [];
      }
      logger.error(`Error fetching Bitquery PnL for ${walletAddress}:`, error);
      return [];
    }
  }

  async getOHLCV(mint: string, timeframe: 'minute' | 'hour' | 'day', limit: number = 100): Promise<BitqueryOHLCV[]> {
    if (!this.apiKey || this.disabled) return [];
    // Bitquery interval syntax: {count: 1, in: minutes} or {count: 1, in: hours}
    const interval = timeframe === 'minute' ? 'minutes' : timeframe === 'hour' ? 'hours' : 'days';
    
    // We want price in USD. Usually against specific quote token, but Bitquery has `PriceInUSD` helper.
    const query = `
      query TokenOHLCV($mint: String!, $limit: Int!, $interval: String!) {
        Solana {
          DEXTradeByTokens(
            options: {desc: "Block_Time", limit: $limit}
            where: {
              Trade: {
                Currency: {
                  MintAddress: {is: $mint}
                }
              }
            }
          ) {
            Block {
              Time(interval: {count: 1, in: $interval})
            }
            Trade {
              high: PriceInUSD(maximum: Trade_PriceInUSD)
              low: PriceInUSD(minimum: Trade_PriceInUSD)
              open: PriceInUSD(minimum: Block_Number) 
              close: PriceInUSD(maximum: Block_Number)
            }
            volume: sum(of: Trade_Side_AmountInUSD)
          }
        }
      }
    `;

    try {
      const response = await axios.post(
        BITQUERY_ENDPOINT,
        {
          query,
          variables: { mint, limit, interval: interval }, // Pass "minutes", "hours", "days" as string
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`,
          },
        }
      );

      if (response.data.errors) {
         // Bitquery often returns "no data" as empty array, but if error, log it.
         // logger.error('Bitquery OHLCV errors:', response.data.errors);
         return [];
      }

      const results = response.data.data?.Solana?.DEXTradeByTokens || [];
      
      // Map results to OHLCV
      // Note: Bitquery returns descending by default with our option.
      // We want chronological order usually (oldest first) for ATH calculation? 
      // Actually standard is chronological.
      // Let's reverse it.
      
      return results.map((item: any) => ({
          timestamp: new Date(item.Block.Time).getTime(),
          open: Number(item.Trade.open),
          high: Number(item.Trade.high),
          low: Number(item.Trade.low),
          close: Number(item.Trade.close),
          volume: Number(item.volume)
      })).reverse();

    } catch (error: any) {
      if (error?.response?.status === 401) {
        this.disabled = true;
        logger.warn('Bitquery unauthorized (401). Disabling Bitquery for this runtime.');
        return [];
      }
      logger.error(`Error fetching Bitquery OHLCV for ${mint}:`, error);
      return [];
    }
  }
}

export const bitquery = new BitqueryProvider(process.env.BIT_QUERY_API_KEY || '');
