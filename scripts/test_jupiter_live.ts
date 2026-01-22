import 'dotenv/config';
import { getMultipleTokenPrices, getMultipleTokenInfo } from '../src/providers/jupiter';
import { logger } from '../src/utils/logger';

// Test tokens
const testTokens = [
  '7nsmpDhPEaqe6xb3BiX6f5jPcqGQnwV3esznCqrepump',
  'So11111111111111111111111111111111111111112', // SOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
];

async function testJupiterAPIs() {
  console.log('\n=== Testing Jupiter API Functions ===\n');
  console.log(`API Key present: ${process.env.JUPITER_API_KEY ? 'YES' : 'NO'}\n`);

  // Test 1: getMultipleTokenPrices
  console.log('1. Testing getMultipleTokenPrices()...');
  console.log(`   Tokens: ${testTokens.length}`);
  const start1 = Date.now();
  try {
    const prices = await getMultipleTokenPrices(testTokens);
    const elapsed1 = Date.now() - start1;
    console.log(`   ✅ Completed in ${elapsed1}ms`);
    console.log(`   Results:`);
    Object.entries(prices).forEach(([mint, price]) => {
      const shortMint = `${mint.slice(0, 8)}...${mint.slice(-4)}`;
      console.log(`     ${shortMint}: ${price !== null ? `$${price}` : 'null'}`);
    });
    const found = Object.values(prices).filter(p => p !== null && p > 0).length;
    console.log(`   Found: ${found}/${testTokens.length} prices\n`);
  } catch (err: any) {
    console.log(`   ❌ ERROR: ${err.message}\n`);
  }

  // Test 2: getMultipleTokenInfo
  console.log('2. Testing getMultipleTokenInfo()...');
  console.log(`   Tokens: ${testTokens.length}`);
  const start2 = Date.now();
  try {
    const tokenInfo = await getMultipleTokenInfo(testTokens);
    const elapsed2 = Date.now() - start2;
    console.log(`   ✅ Completed in ${elapsed2}ms`);
    console.log(`   Results:`);
    Object.entries(tokenInfo).forEach(([mint, info]) => {
      const shortMint = `${mint.slice(0, 8)}...${mint.slice(-4)}`;
      if (info) {
        console.log(`     ${shortMint}:`);
        console.log(`       Symbol: ${info.symbol || 'N/A'}`);
        console.log(`       Price: $${info.usdPrice || 'N/A'}`);
        console.log(`       Market Cap: $${info.mcap || 'N/A'}`);
        console.log(`       Has audit: ${!!info.audit}`);
      } else {
        console.log(`     ${shortMint}: null`);
      }
    });
    const found = Object.values(tokenInfo).filter(t => t !== null).length;
    console.log(`   Found: ${found}/${testTokens.length} tokens\n`);
  } catch (err: any) {
    console.log(`   ❌ ERROR: ${err.message}\n`);
  }

  // Test 3: Test with many tokens (like live signals would)
  console.log('3. Testing with 50 tokens (simulating live signals)...');
  const manyTokens = [
    ...testTokens,
    ...Array.from({ length: 47 }, (_, i) => `Token${i}`) // Dummy tokens to test batch
  ];
  const start3 = Date.now();
  try {
    const prices = await getMultipleTokenPrices(manyTokens);
    const elapsed3 = Date.now() - start3;
    console.log(`   ✅ Completed in ${elapsed3}ms`);
    const found = Object.values(prices).filter(p => p !== null && p > 0).length;
    console.log(`   Found: ${found}/${manyTokens.length} prices`);
    console.log(`   Rate: ${(manyTokens.length / (elapsed3 / 1000)).toFixed(1)} tokens/second\n`);
  } catch (err: any) {
    console.log(`   ❌ ERROR: ${err.message}\n`);
  }

  console.log('=== Test Complete ===\n');
}

testJupiterAPIs().catch(console.error);

