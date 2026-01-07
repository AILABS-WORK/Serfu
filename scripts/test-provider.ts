import dotenv from 'dotenv';
// Load env BEFORE importing other modules that use env vars
dotenv.config();

import { provider } from '../src/providers';
import { logger } from '../src/utils/logger';

const main = async () => {
  try {
    const mint = 'G2dJVAF27n4xBGjftmrpTydiUGb5eCjferW3KDRubonk'; // Test token
    logger.info(`Fetching metadata for ${mint}...`);
    
    // Check if key is loaded now
    if (!process.env.HELIUS_API_KEY) {
        throw new Error('HELIUS_API_KEY is missing in process.env');
    }
    
    logger.info(`✅ HELIUS_API_KEY loaded (length: ${process.env.HELIUS_API_KEY.length}, starts with: ${process.env.HELIUS_API_KEY.substring(0, 8)}...)`);

    const meta = await provider.getTokenMeta(mint);
    logger.info('Metadata:', meta);

    logger.info(`Fetching price for ${mint}...`);
    const quote = await provider.getQuote(mint);
    logger.info('Quote:', quote);

    if (meta.name !== 'Unknown' && quote.price >= 0) {
      logger.info('✅ Provider Test Passed');
      logger.info(`Token: ${meta.name} (${meta.symbol})`);
      logger.info(`Price: $${quote.price}`);
    } else {
      logger.error('❌ Provider Test Failed: Data mismatch');
    }

  } catch (error) {
    logger.error('❌ Provider Test Failed:', error);
  }
};

main();
