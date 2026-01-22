import 'dotenv/config';
import { getMultipleTokenInfo } from '../src/providers/jupiter';

// Simulate what liveSignals does
async function testLiveSignalsFlow() {
  console.log('\n=== Testing Live Signals Data Flow ===\n');

  // Test with real tokens
  const testMints = [
    '7nsmpDhPEaqe6xb3BiX6f5jPcqGQnwV3esznCqrepump',
    'So11111111111111111111111111111111111111112', // SOL
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  ];

  console.log('1. Fetching token info...');
  const tokenInfoMap = await getMultipleTokenInfo(testMints);
  console.log(`   Found: ${Object.values(tokenInfoMap).filter(t => t !== null).length}/${testMints.length} tokens\n`);

  // Extract prices and market caps (like liveSignals does)
  const priceMap: Record<string, number | null> = {};
  const marketCapMap: Record<string, number | null> = {};

  Object.entries(tokenInfoMap).forEach(([mint, info]) => {
    if (info) {
      priceMap[mint] = info.usdPrice ?? null;
      marketCapMap[mint] = info.mcap ?? null;
      console.log(`   ${mint.slice(0, 8)}...:`);
      console.log(`     Price: ${priceMap[mint]}`);
      console.log(`     Market Cap: ${marketCapMap[mint]}`);
    } else {
      priceMap[mint] = null;
      marketCapMap[mint] = null;
      console.log(`   ${mint.slice(0, 8)}...: NULL`);
    }
  });

  console.log('\n2. Simulating signal processing...');
  testMints.forEach((mint, idx) => {
    const entryPrice = 0.0001; // Example entry price
    const entryMc = 100000; // Example entry market cap
    
    const currentPrice = priceMap[mint] ?? null;
    const currentMc = marketCapMap[mint] ?? null;
    
    let pnl = -Infinity;
    if (currentPrice !== null && currentPrice > 0 && entryPrice > 0) {
      pnl = ((currentPrice - entryPrice) / entryPrice) * 100;
    } else if (currentMc !== null && currentMc > 0 && entryMc > 0) {
      pnl = ((currentMc - entryMc) / entryMc) * 100;
    }
    
    console.log(`\n   Signal ${idx + 1} (${mint.slice(0, 8)}...):`);
    console.log(`     Entry Price: $${entryPrice}`);
    console.log(`     Entry MC: $${entryMc}`);
    console.log(`     Current Price: ${currentPrice !== null ? `$${currentPrice}` : 'null'}`);
    console.log(`     Current MC: ${currentMc !== null ? `$${currentMc}` : 'null'}`);
    console.log(`     PnL: ${isFinite(pnl) ? `${pnl.toFixed(2)}%` : 'N/A'}`);
    console.log(`     Will display: ${currentMc !== null && currentMc > 0 ? 'YES' : 'NO (N/A)'}`);
  });

  console.log('\n=== Test Complete ===\n');
}

testLiveSignalsFlow().catch(console.error);

