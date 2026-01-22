import 'dotenv/config';
import { getMultipleTokenInfo } from '../src/providers/jupiter';

const testMint = 'BPLEyoTtmPSa9ExmFEEvJP3s2uBZNCm6Z2gWH8Bqpump';

async function testSpecificToken() {
  console.log(`\n=== Testing Token: ${testMint} ===\n`);
  
  const tokenInfoMap = await getMultipleTokenInfo([testMint]);
  const info = tokenInfoMap[testMint];
  
  if (info) {
    console.log('✅ Token found!');
    console.log(`   Symbol: ${info.symbol}`);
    console.log(`   Name: ${info.name}`);
    console.log(`   Price: $${info.usdPrice}`);
    console.log(`   Market Cap: $${info.mcap}`);
    console.log(`   Has audit: ${!!info.audit}`);
    
    // Simulate what liveSignals does
    const priceMap: Record<string, number | null> = {};
    const marketCapMap: Record<string, number | null> = {};
    
    priceMap[testMint] = info.usdPrice ?? null;
    marketCapMap[testMint] = info.mcap ?? null;
    
    console.log(`\n   Extracted:`);
    console.log(`   priceMap[token] = ${priceMap[testMint]}`);
    console.log(`   marketCapMap[token] = ${marketCapMap[testMint]}`);
    
    // Simulate signal processing
    const entryPrice = 0.0001;
    const entryMc = 50000;
    const currentPrice = priceMap[testMint] ?? null;
    const currentMc = marketCapMap[testMint] ?? null;
    
    let pnl = -Infinity;
    if (currentPrice !== null && currentPrice > 0 && entryPrice > 0) {
      pnl = ((currentPrice - entryPrice) / entryPrice) * 100;
    } else if (currentMc !== null && currentMc > 0 && entryMc > 0) {
      pnl = ((currentMc - entryMc) / entryMc) * 100;
    }
    
    console.log(`\n   Signal Processing:`);
    console.log(`   currentPrice: ${currentPrice}`);
    console.log(`   currentMc: ${currentMc}`);
    console.log(`   pnl: ${isFinite(pnl) ? `${pnl.toFixed(2)}%` : 'N/A'}`);
    
    // Simulate cache storage
    const cachedSignal = {
      currentPrice: currentPrice ?? 0,
      currentMc: currentMc ?? 0,
      pnl,
    };
    
    console.log(`\n   Cached Signal:`);
    console.log(`   currentPrice: ${cachedSignal.currentPrice}`);
    console.log(`   currentMc: ${cachedSignal.currentMc}`);
    console.log(`   pnl: ${cachedSignal.pnl}`);
    
    // Simulate display
    const currentStr = cachedSignal.currentMc > 0 ? `$${cachedSignal.currentMc.toLocaleString()}` : 'N/A';
    const pnlStr = isFinite(cachedSignal.pnl) ? `${cachedSignal.pnl.toFixed(2)}%` : 'N/A';
    
    console.log(`\n   Display:`);
    console.log(`   currentStr: ${currentStr}`);
    console.log(`   pnlStr: ${pnlStr}`);
    console.log(`   Will show: Entry: $50K → Now: ${currentStr} (${pnlStr})`);
  } else {
    console.log('❌ Token NOT found!');
    console.log('   This means Jupiter search endpoint returned no results for this token.');
  }
  
  console.log('\n=== Test Complete ===\n');
}

testSpecificToken().catch(console.error);
