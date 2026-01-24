/* eslint-disable no-console */
import dotenv from 'dotenv';

dotenv.config();

async function main() {
  const apiKey = process.env.BIT_QUERY_API_KEY;
  if (!apiKey) {
    console.error('Missing BIT_QUERY_API_KEY in environment.');
    process.exit(1);
  }

  const mintArg = process.argv[2];
  const mint = mintArg || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // USDC

  const { bitquery } = await import('../src/providers/bitquery');

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  console.log(`Testing Bitquery price extremes for ${mint} since ${since.toISOString()}...`);
  const extremes = await bitquery.getPriceExtremes(mint, since);
  console.log('Extremes:', extremes);

  console.log('Testing Bitquery bulk ATH for 2 mints...');
  const bulk = await bitquery.getBulkTokenATH([
    mint,
    'So11111111111111111111111111111111111111112', // SOL
  ]);
  for (const [key, value] of bulk.entries()) {
    console.log(`${key}:`, value);
  }
}

main().catch((err) => {
  console.error('Bitquery smoke test failed:', err);
  process.exit(1);
});

