/**
 * Test ATH calculation for token "g" specifically
 * Token: 8CKUs3cXFVMaZQTeyqW6v1Lno1iS755tiWzJfbBgpump
 * Called at 11:43 PM Lisbon time (23:43 CET = 22:43 UTC) at 6.4k entry
 * Current MC from image: $15.41K
 * Expected ATH should be >= 15.41k / 6.4k = 2.4x (but likely higher if it went to 100k)
 */

import { geckoTerminal } from '../src/providers/geckoTerminal';
import { bitquery } from '../src/providers/bitquery';
import { logger } from '../src/utils/logger';

const TOKEN_G = '8CKUs3cXFVMaZQTeyqW6v1Lno1iS755tiWzJfbBgpump';
// 11:43 PM Lisbon time = 23:43 CET (assuming CET, which is UTC+1)
// For January, Lisbon is in WET (UTC+0), so 23:43 WET = 23:43 UTC
// Let's use approximate date/time - we'll need to adjust based on when this was called
// Entry MC: 6.4k ($6,400)
// Current MC: 15.41k ($15,410)
const ENTRY_MC = 6400;
const CURRENT_MC = 15410;

// Approximate entry timestamp (user said 11:43 PM Lisbon time)
// We'll calculate ATH from a recent timestamp to test
// For now, let's assume it was called today at 23:43 UTC
function getEntryTimestamp(): number {
  const now = new Date();
  // Set to today at 23:43 UTC (or adjust based on actual call time)
  const entryDate = new Date(now);
  entryDate.setUTCHours(23, 43, 0, 0);
  // If it's before 23:43 today, use yesterday
  if (entryDate.getTime() > now.getTime()) {
    entryDate.setUTCDate(entryDate.getUTCDate() - 1);
  }
  return entryDate.getTime();
}

async function testGeckoTerminalATH() {
  console.log('\n🔍 Testing GeckoTerminal ATH calculation for token "g"...\n');
  
  const entryTimestamp = getEntryTimestamp();
  const nowTimestamp = Date.now();
  const entryPrice = ENTRY_MC / 1000000000; // Assuming supply of 1B for calculation
  let maxHigh = 0;
  
  console.log(`Entry timestamp: ${new Date(entryTimestamp).toISOString()}`);
  console.log(`Now timestamp: ${new Date(nowTimestamp).toISOString()}`);
  console.log(`Entry MC: $${ENTRY_MC.toLocaleString()}`);
  
  try {
    // Try minute candles
    console.log('\n📊 Fetching minute candles...');
    const minuteCandles = await geckoTerminal.getOHLCV(TOKEN_G, 'minute', 1000);
    const postEntryMinutes = minuteCandles.filter((c) => c.timestamp >= entryTimestamp);
    console.log(`Found ${postEntryMinutes.length} minute candles after entry`);
    
    for (const candle of postEntryMinutes) {
      if (candle.high > maxHigh) {
        maxHigh = candle.high;
      }
    }
    
    // Try hourly candles
    if (postEntryMinutes.length === 0) {
      console.log('\n📊 Fetching hourly candles...');
      const hourlyCandles = await geckoTerminal.getOHLCV(TOKEN_G, 'hour', 1000);
      const postEntryHours = hourlyCandles.filter((c) => c.timestamp >= entryTimestamp);
      console.log(`Found ${postEntryHours.length} hourly candles after entry`);
      
      for (const candle of postEntryHours) {
        if (candle.high > maxHigh) {
          maxHigh = candle.high;
        }
      }
    }
    
    if (maxHigh > 0) {
      const athMultiple = maxHigh / entryPrice;
      const athMc = maxHigh * 1000000000; // Assuming supply of 1B
      console.log(`\n✅ ATH Calculation:`);
      console.log(`   Max High Price: $${maxHigh.toFixed(8)}`);
      console.log(`   Entry Price: $${entryPrice.toFixed(8)}`);
      console.log(`   ATH Multiple: ${athMultiple.toFixed(2)}x`);
      console.log(`   ATH MC: $${athMc.toLocaleString()}`);
      console.log(`   Current MC: $${CURRENT_MC.toLocaleString()}`);
      console.log(`   Min Expected ATH: ${(CURRENT_MC / ENTRY_MC).toFixed(2)}x`);
      
      if (athMultiple >= (CURRENT_MC / ENTRY_MC)) {
        console.log(`\n✅ ATH is correct (${athMultiple.toFixed(2)}x >= ${(CURRENT_MC / ENTRY_MC).toFixed(2)}x)`);
      } else {
        console.log(`\n❌ ATH is too low (${athMultiple.toFixed(2)}x < ${(CURRENT_MC / ENTRY_MC).toFixed(2)}x)`);
      }
    } else {
      console.log('\n❌ No candles found after entry timestamp');
    }
  } catch (err) {
    console.error('❌ GeckoTerminal test failed:', err);
  }
}

async function testBitqueryATH() {
  console.log('\n🔍 Testing Bitquery ATH calculation for token "g"...\n');
  
  const entryTimestamp = getEntryTimestamp();
  const entryPrice = ENTRY_MC / 1000000000;
  let maxHigh = 0;
  
  try {
    const minuteCandles = await bitquery.getOHLCV(TOKEN_G, 'minute', 1000);
    const postEntryMinutes = minuteCandles.filter((c) => c.timestamp >= entryTimestamp);
    console.log(`Found ${postEntryMinutes.length} minute candles after entry`);
    
    for (const candle of postEntryMinutes) {
      if (candle.high > maxHigh) {
        maxHigh = candle.high;
      }
    }
    
    if (maxHigh > 0) {
      const athMultiple = maxHigh / entryPrice;
      console.log(`\n✅ Bitquery ATH: ${athMultiple.toFixed(2)}x`);
    } else {
      console.log('\n❌ Bitquery found no candles');
    }
  } catch (err) {
    console.error('❌ Bitquery test failed:', err);
  }
}

async function main() {
  console.log('🧪 Testing ATH Calculation for Token "g"\n');
  console.log(`Token: ${TOKEN_G}`);
  console.log(`Entry MC: $${ENTRY_MC.toLocaleString()} (6.4k)`);
  console.log(`Current MC: $${CURRENT_MC.toLocaleString()} (15.41k)`);
  
  await testGeckoTerminalATH();
  await testBitqueryATH();
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});

