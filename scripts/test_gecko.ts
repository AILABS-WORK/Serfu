import axios from 'axios';
import { prisma } from '../src/db';
import { geckoTerminal } from '../src/providers/geckoTerminal';

async function testHistory() {
  const mint = 'Jkh1SbHoEuHcf1z6k6tJSZ79V4eq9hs26dWwg4Kpump'; 
  console.log(`Testing with ${mint}...`);
  
  let poolAddress = '';

  try {
    const dsUrl = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;
    const dsRes = await axios.get(dsUrl);
    const pairs = dsRes.data?.pairs;
    console.log(`DexScreener Pairs: ${pairs?.length}`);
    if (pairs && pairs.length > 0) {
      poolAddress = pairs[0].pairAddress;
      console.log('Top Pair:', pairs[0].dexId, poolAddress, pairs[0].priceUsd);
    }
  } catch (e: any) {
    console.log('DexScreener failed:', e.message);
  }

  if (poolAddress) {
    console.log(`Trying GeckoTerminal with explicit pool address: ${poolAddress}`);
    try {
        const url = `https://api.geckoterminal.com/api/v2/networks/solana/pools/${poolAddress}/ohlcv/minute`;
        const res = await axios.get(url, { params: { limit: 5 } });
        const list = res.data?.data?.attributes?.ohlcv_list;
        console.log(`Gecko Candles via Pair: ${list?.length}`);
        if (list && list.length > 0) console.log(list[0]);
    } catch (e: any) {
        console.log('Gecko explicit pair failed:', e.message);
    }
  }
}

testHistory().catch(console.error).finally(() => prisma.$disconnect());
