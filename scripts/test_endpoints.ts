import dotenv from 'dotenv';
dotenv.config();

import axios from 'axios';
import { provider } from '../src/providers';
import { geckoTerminal } from '../src/providers/geckoTerminal';
import { getJupiterTokenInfo, getJupiterPrice, getMultipleTokenPrices } from '../src/providers/jupiter';
import { BitqueryProvider } from '../src/providers/bitquery';
import { logger } from '../src/utils/logger';

const TEST_MINTS = [
  'G2dJVAF27n4xBGjftmrpTydiUGb5eCjferW3KDRubonk',
  'Jkh1SbHoEuHcf1z6k6tJSZ79V4eq9hs26dWwg4Kpump',
];

const TEST_WALLET = '11111111111111111111111111111111';

const logStep = (label: string) => logger.info(`\n=== ${label} ===`);

const main = async () => {
  try {
    logStep('Provider.getTokenMeta');
    for (const mint of TEST_MINTS) {
      try {
        const meta = await provider.getTokenMeta(mint);
        logger.info(`Meta ${mint}: name=${meta.name} symbol=${meta.symbol} mcap=${meta.marketCap ?? 'N/A'}`);
      } catch (err) {
        logger.warn(`Meta failed for ${mint}: ${String(err)}`);
      }
    }

    logStep('Provider.getQuote');
    for (const mint of TEST_MINTS) {
      try {
        const quote = await provider.getQuote(mint);
        logger.info(`Quote ${mint}: price=${quote.price} source=${quote.source}`);
      } catch (err) {
        logger.warn(`Quote failed for ${mint}: ${String(err)}`);
      }
    }

    logStep('Jupiter.getMultipleTokenPrices');
    try {
      const batchPrices = await getMultipleTokenPrices(TEST_MINTS);
      logger.info(`Batch prices: ${JSON.stringify(batchPrices)}`);
    } catch (err) {
      logger.warn(`Batch price failed: ${String(err)}`);
    }

    logStep('Jupiter.getJupiterTokenInfo');
    for (const mint of TEST_MINTS) {
      try {
        const info = await getJupiterTokenInfo(mint);
        logger.info(`Jupiter info ${mint}: ${info?.name ?? 'N/A'} (${info?.symbol ?? 'N/A'})`);
      } catch (err) {
        logger.warn(`Jupiter info failed for ${mint}: ${String(err)}`);
      }
    }

    logStep('Jupiter.getJupiterPrice');
    for (const mint of TEST_MINTS) {
      try {
        const price = await getJupiterPrice(mint, 9);
        logger.info(`Jupiter price ${mint}: price=${price.price} source=${price.source}`);
      } catch (err) {
        logger.warn(`Jupiter price failed for ${mint}: ${String(err)}`);
      }
    }

    logStep('DexScreener + GeckoTerminal OHLCV');
    for (const mint of TEST_MINTS) {
      try {
        const dsUrl = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;
        const dsRes = await axios.get(dsUrl);
        const pairs = dsRes.data?.pairs || [];
        const pool = pairs[0]?.pairAddress;
        logger.info(`DexScreener ${mint}: pairs=${pairs.length} pool=${pool ?? 'N/A'}`);
      } catch (err) {
        logger.warn(`DexScreener failed for ${mint}: ${String(err)}`);
      }
      try {
        const ohlcv = await geckoTerminal.getOHLCV(mint, 'minute', 25);
        logger.info(`Gecko OHLCV ${mint}: candles=${ohlcv.length}`);
      } catch (err) {
        logger.warn(`Gecko OHLCV failed for ${mint}: ${String(err)}`);
      }
    }

    logStep('Helius Wallet Assets/History');
    const heliusProvider = provider as any;
    if (typeof heliusProvider.getWalletAssets === 'function') {
      const assets = await heliusProvider.getWalletAssets(TEST_WALLET);
      logger.info(`Wallet assets (${TEST_WALLET}): ${assets.length} items`);
    } else {
      logger.warn('Wallet assets method unavailable');
    }
    if (typeof heliusProvider.getWalletHistory === 'function') {
      const history = await heliusProvider.getWalletHistory(TEST_WALLET, 10);
      logger.info(`Wallet history (${TEST_WALLET}): ${history.length} txs`);
    } else {
      logger.warn('Wallet history method unavailable');
    }

    logStep('Bitquery Wallet PnL (optional)');
    const bitqueryKey = (process.env.BITQUERY_API_KEY || '').trim();
    if (!bitqueryKey) {
      logger.warn('BITQUERY_API_KEY missing; skipping bitquery test');
    } else {
      const bitquery = new BitqueryProvider(bitqueryKey);
      const pnl = await bitquery.getWalletPnL(TEST_WALLET);
      logger.info(`Bitquery PnL: ${pnl.length} results`);
    }

    logger.info('✅ Endpoint test suite complete.');
  } catch (error) {
    logger.error('❌ Endpoint test suite failed:', error);
    process.exitCode = 1;
  }
};

main();

