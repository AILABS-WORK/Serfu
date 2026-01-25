import { logger } from '../utils/logger';
import axios from 'axios';

const BITQUERY_ENDPOINT = 'https://streaming.bitquery.io/graphql'; // Bitquery streaming GraphQL endpoint

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

export interface BitqueryBulkAthResult {
  mint: string;
  athPrice: number;
  athMarketCap: number;
  startingPrice: number;
  startingMarketCap: number;
  name?: string;
  symbol?: string;
}

export interface BitqueryFirstBuyer {
  wallet: string;
  amount: number;
  timestamp: Date;
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

  /**
   * Bulk ATH and starting market cap for multiple tokens in one query.
   * Uses a fixed 1B supply assumption from Bitquery examples.
   */
  async getBulkTokenATH(mints: string[], since: Date = new Date(0)): Promise<Map<string, BitqueryBulkAthResult>> {
    const resultsMap = new Map<string, BitqueryBulkAthResult>();
    if (!this.apiKey || this.disabled || mints.length === 0) return resultsMap;

    const query = `
      query GetAthMarketCap($tokens: [String!]!, $since: DateTime!) {
        Solana(dataset: combined) {
          DEXTradeByTokens(
            limitBy: { by: Trade_Currency_MintAddress, count: 1 }
            where: {
              Trade: {
                Currency: { MintAddress: { in: $tokens } }
                Side: {
                  Currency: {
                    MintAddress: { in: ["11111111111111111111111111111111", "So11111111111111111111111111111111111111112"] }
                  }
                }
              }
              Block: { Time: { since: $since } }
            }
          ) {
            Trade {
              Currency {
                MintAddress
                Name
                Symbol
              }
              PriceInUSD(maximum: Trade_PriceInUSD)
              Side {
                Currency { Symbol }
              }
            }
            max: quantile(of: Trade_PriceInUSD, level: 0.98)
            ATH_Marketcap: calculate(expression: "$max * 1000000000")
          }
        }
      }
    `;

    try {
      const response = await axios.post(
        BITQUERY_ENDPOINT,
        {
          query,
          variables: { tokens: mints, since: since.toISOString() },
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`,
          },
        }
      );

      if (response.data.errors) {
        logger.error('Bitquery bulk ATH errors:', response.data.errors);
        return resultsMap;
      }

      const rows = response.data.data?.Solana?.DEXTradeByTokens || [];
      for (const row of rows) {
        const mint = row?.Trade?.Currency?.MintAddress;
        if (!mint) continue;
        const athPrice = Number(row.max || row?.Trade?.PriceInUSD || 0);
        const startingPrice = 0;
        const athMarketCap = Number(row.ATH_Marketcap || 0);
        const startingMarketCap = 0;

        resultsMap.set(mint, {
          mint,
          athPrice,
          athMarketCap,
          startingPrice,
          startingMarketCap,
          name: row?.Trade?.Currency?.Name || undefined,
          symbol: row?.Trade?.Currency?.Symbol || undefined,
        });
      }

      return resultsMap;
    } catch (error: any) {
      if (error?.response?.status === 401) {
        this.disabled = true;
        logger.warn('Bitquery unauthorized (401). Disabling Bitquery for this runtime.');
        return resultsMap;
      }
      logger.error('Error fetching Bitquery bulk ATH:', error);
      return resultsMap;
    }
  }

  /**
   * Get ATH price and price change percentages (24h/7d/30d).
   */
  async getATHWithPriceChange(mint: string): Promise<{
    athPrice: number;
    currentPrice: number;
    change24h: number;
    change7d: number;
    change30d: number;
  }> {
    if (!this.apiKey || this.disabled) {
      return { athPrice: 0, currentPrice: 0, change24h: 0, change7d: 0, change30d: 0 };
    }

    const query = `
      query ($token: String) {
        Solana(dataset: combined) {
          DEXTradeByTokens(
            where: {Trade: {Side: {Currency: {MintAddress: {in: ["11111111111111111111111111111111", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", "So11111111111111111111111111111111111111112"]}}, AmountInUSD: {gt: "10"}}, Currency: {MintAddress: {is: $token}}, PriceAsymmetry: {lt: 0.01}}, Transaction: {Result: {Success: true}}}
            limit: {count: 1}
          ) {
            Trade {
              Price_24h_ago: PriceInUSD(
                minimum: Block_Slot
                if: {Block: {Time: {since_relative: {hours_ago: 24}}}}
              )
              Price_7d_ago: PriceInUSD(
                minimum: Block_Slot
                if: {Block: {Time: {since_relative: {days_ago: 7}}}}
              )
              Price_30d_ago: PriceInUSD(
                minimum: Block_Slot
                if: {Block: {Time: {since_relative: {days_ago: 30}}}}
              )
              CurrentPrice: PriceInUSD(maximum: Block_Slot)
            }
            change24hr: calculate(
              expression: "(($Trade_CurrentPrice - $Trade_Price_24h_ago) / $Trade_Price_24h_ago) * 100"
            )
            change7d: calculate(
              expression: "(($Trade_CurrentPrice - $Trade_Price_7d_ago) / $Trade_Price_7d_ago) * 100"
            )
            change30d: calculate(
              expression: "(($Trade_CurrentPrice - $Trade_Price_30d_ago) / $Trade_Price_30d_ago) * 100"
            )
            aATH: quantile(of: Trade_PriceInUSD, level: 0.95)
          }
        }
      }
    `;

    try {
      const response = await axios.post(
        BITQUERY_ENDPOINT,
        { query, variables: { token: mint } },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`,
          },
        }
      );

      if (response.data.errors) {
        logger.error('Bitquery ATH+price change errors:', response.data.errors);
        return { athPrice: 0, currentPrice: 0, change24h: 0, change7d: 0, change30d: 0 };
      }

      const row = response.data.data?.Solana?.DEXTradeByTokens?.[0];
      return {
        athPrice: Number(row?.aATH || 0),
        currentPrice: Number(row?.Trade?.CurrentPrice || 0),
        change24h: Number(row?.change24hr || 0),
        change7d: Number(row?.change7d || 0),
        change30d: Number(row?.change30d || 0),
      };
    } catch (error: any) {
      if (error?.response?.status === 401) {
        this.disabled = true;
        logger.warn('Bitquery unauthorized (401). Disabling Bitquery for this runtime.');
        return { athPrice: 0, currentPrice: 0, change24h: 0, change7d: 0, change30d: 0 };
      }
      logger.error('Error fetching Bitquery ATH+price change:', error);
      return { athPrice: 0, currentPrice: 0, change24h: 0, change7d: 0, change30d: 0 };
    }
  }

  /**
   * Get max/min prices since a timestamp for drawdown calculations.
   */
  async getPriceExtremes(mint: string, since: Date): Promise<{
    maxPrice: number;
    maxAt: Date;
    minPrice: number;
    minAt: Date;
  }> {
    if (!this.apiKey || this.disabled) {
      return { maxPrice: 0, maxAt: since, minPrice: 0, minAt: since };
    }

    const query = `
      query TokenPriceExtremes($mint: String!, $since: DateTime!) {
        Solana(dataset: combined) {
          DEXTradeByTokens(
            where: {
              Block: { Time: { since: $since } }
              Trade: {
                Currency: { MintAddress: { is: $mint } }
                Side: { AmountInUSD: { gt: "0" } }
              }
            }
          ) {
            Trade {
              maxPrice: PriceInUSD(maximum: Trade_PriceInUSD)
              minPrice: PriceInUSD(minimum: Trade_PriceInUSD)
            }
            Block {
              maxTime: Time(maximum: Block_Time)
              minTime: Time(minimum: Block_Time)
            }
          }
        }
      }
    `;

    try {
      const response = await axios.post(
        BITQUERY_ENDPOINT,
        { query, variables: { mint, since: since.toISOString() } },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`,
          },
        }
      );

      if (response.data.errors) {
        logger.error('Bitquery price extremes errors:', response.data.errors);
        return { maxPrice: 0, maxAt: since, minPrice: 0, minAt: since };
      }

      const row = response.data.data?.Solana?.DEXTradeByTokens?.[0];
      const maxPrice = Number(row?.Trade?.maxPrice || 0);
      const minPrice = Number(row?.Trade?.minPrice || 0);
      const maxAt = row?.Block?.maxTime ? new Date(row.Block.maxTime) : since;
      const minAt = row?.Block?.minTime ? new Date(row.Block.minTime) : since;

      return {
        maxPrice,
        maxAt,
        minPrice,
        minAt,
      };
    } catch (error: any) {
      if (error?.response?.status === 401) {
        this.disabled = true;
        logger.warn('Bitquery unauthorized (401). Disabling Bitquery for this runtime.');
        return { maxPrice: 0, maxAt: since, minPrice: 0, minAt: since };
      }
      logger.error('Error fetching Bitquery price extremes:', error);
      return { maxPrice: 0, maxAt: since, minPrice: 0, minAt: since };
    }
  }

  /**
   * Get first 100 buyers of a token.
   */
  async getFirst100Buyers(mint: string): Promise<BitqueryFirstBuyer[]> {
    if (!this.apiKey || this.disabled) return [];

    const query = `
      query First100Buyers($token: String!) {
        Solana {
          DEXTrades(
            where: {Trade: {Buy: {Currency: {MintAddress: {is: $token}}}}}
            limit: { count: 100 }
            orderBy: { ascending: Block_Time }
          ) {
            Block {
              Time
            }
            Trade {
              Buy {
                Amount
                Account {
                  Token {
                    Owner
                  }
                }
              }
            }
          }
        }
      }
    `;

    try {
      const response = await axios.post(
        BITQUERY_ENDPOINT,
        { query, variables: { token: mint } },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`,
          },
        }
      );

      if (response.data.errors) {
        logger.error('Bitquery first buyers errors:', response.data.errors);
        return [];
      }

      const rows = response.data.data?.Solana?.DEXTrades || [];
      return rows.map((row: any) => ({
        wallet: row?.Trade?.Buy?.Account?.Token?.Owner || 'unknown',
        amount: Number(row?.Trade?.Buy?.Amount || 0),
        timestamp: row?.Block?.Time ? new Date(row.Block.Time) : new Date(0)
      })).filter((b: BitqueryFirstBuyer) => b.wallet !== 'unknown');
    } catch (error: any) {
      if (error?.response?.status === 401) {
        this.disabled = true;
        logger.warn('Bitquery unauthorized (401). Disabling Bitquery for this runtime.');
        return [];
      }
      logger.error('Error fetching Bitquery first buyers:', error);
      return [];
    }
  }
}

export const bitquery = new BitqueryProvider(process.env.BIT_QUERY_API_KEY || '');
