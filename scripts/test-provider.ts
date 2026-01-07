import dotenv from 'dotenv';
// Load env BEFORE importing other modules that use env vars
dotenv.config();

import { provider } from '../src/providers';
import { logger } from '../src/utils/logger';

const main = async () => {
  try {
    const mint = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'; // BONK
    logger.info(`Fetching metadata for ${mint}...`);
    
    // Check if key is loaded now
    if (!process.env.HELIUS_API_KEY) {
        throw new Error('HELIUS_API_KEY is missing in process.env');
    }

    const meta = await provider.getTokenMeta(mint);
    logger.info('Metadata:', meta);

    logger.info(`Fetching price for ${mint}...`);
    const quote = await provider.getQuote(mint);
    logger.info('Quote:', quote);

    if (meta.symbol === 'BONK' && quote.price > 0) {
      logger.info('✅ Provider Test Passed');
    } else {
      logger.error('❌ Provider Test Failed: Data mismatch');
    }

  } catch (error) {
    logger.error('❌ Provider Test Failed:', error);
  }
};

main();
