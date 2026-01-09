import fetch from 'node-fetch';
import { logger } from '../utils/logger';

const JUP_URL = 'https://quote-api.jup.ag/v6/quote';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const JUP_API_KEY = process.env.JUPITER_API_KEY || process.env.JUP_API_KEY;

/**
 * Fetch price via Jupiter by quoting 1 SOL to the target mint.
 * Assumes decimals if provided; otherwise defaults to 9.
 */
export const getJupiterPrice = async (mint: string, decimals: number = 9): Promise<number | null> => {
  try {
    const amount = 1_000_000_000; // 1 SOL in lamports
    const url = `${JUP_URL}?inputMint=${SOL_MINT}&outputMint=${mint}&amount=${amount}`;
    const headers: Record<string, string> = {};
    if (JUP_API_KEY) {
      headers['x-api-key'] = JUP_API_KEY;
    }
    const res = await fetch(url, { headers });
    if (!res.ok) {
      logger.debug(`Jupiter quote failed status ${res.status}`);
      return null;
    }
    const data: any = await res.json();
    const outAmount = data?.outAmount;
    if (!outAmount) return null;
    const price = Number(outAmount) / Math.pow(10, decimals); // price per 1 SOL
    return price;
  } catch (err) {
    logger.debug('Jupiter quote error:', err);
    return null;
  }
};


