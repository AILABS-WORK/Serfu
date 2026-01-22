import axios from 'axios';
import { prisma } from '../src/db';
import { geckoTerminal } from '../src/providers/geckoTerminal';

async function testHistory() {
  const mint = '4Khi2zGhb7BdgmFvjEutygAs6civxJoi1WCRt3xKpump'; 
  console.log(`Testing with ${mint}...`);
  
  // 1. Get OHLCV
  const ohlcv = await geckoTerminal.getOHLCV(mint, 'minute', 1000);
  console.log(`Fetched ${ohlcv.length} candles`);
  
  if (ohlcv.length > 0) {
    console.log('First Candle:', new Date(ohlcv[0].timestamp).toISOString(), ohlcv[0].close);
    console.log('Last Candle:', new Date(ohlcv[ohlcv.length - 1].timestamp).toISOString(), ohlcv[ohlcv.length - 1].close);
    
    // 2. Simulate metrics calc
    // Assume entry was 2 hours ago at price X
    const entryTime = Date.now() - (2 * 60 * 60 * 1000);
    const entryPrice = ohlcv.find(c => c.timestamp >= entryTime)?.open || ohlcv[0].open;
    
    console.log(`Simulated Entry: $${entryPrice} at ${new Date(entryTime).toISOString()}`);
    
    const validCandles = ohlcv.filter(c => c.timestamp >= entryTime);
    let ath = 0;
    let min = Infinity;
    
    for (const c of validCandles) {
        if (c.high > ath) ath = c.high;
        if (c.low < min) min = c.low;
    }
    
    console.log(`ATH: $${ath} (${(ath/entryPrice).toFixed(2)}x)`);
    console.log(`Min: $${min} (Drawdown: ${((min-entryPrice)/entryPrice*100).toFixed(2)}%)`);
  }
}

testHistory().catch(console.error).finally(() => prisma.$disconnect());












