import fetch from 'node-fetch';

const JUP_SEARCH_URL = 'https://api.jup.ag/tokens/v2/search';
const JUP_PRICE_URL = 'https://api.jup.ag/price/v3';
const JUP_API_KEY = process.env.JUPITER_API_KEY || process.env.JUP_API_KEY || '';

const testToken = '7nsmpDhPEaqe6xb3BiX6f5jPcqGQnwV3esznCqrepump';

async function testJupiterEndpoints() {
  console.log(`\n=== Testing Jupiter API for token: ${testToken} ===\n`);

  // Test 1: Search endpoint
  console.log('1. Testing SEARCH endpoint (tokens/v2/search)...');
  try {
    const headers: Record<string, string> = {};
    if (JUP_API_KEY) {
      headers['x-api-key'] = JUP_API_KEY;
    }
    const searchUrl = `${JUP_SEARCH_URL}?query=${testToken}`;
    const searchRes = await fetch(searchUrl, { headers });
    
    if (searchRes.ok) {
      const searchData: any = await searchRes.json();
      console.log('✅ Search endpoint SUCCESS');
      if (searchData && searchData.length > 0) {
        const token = searchData[0];
        console.log(`   - Symbol: ${token.symbol}`);
        console.log(`   - Name: ${token.name}`);
        console.log(`   - Price: $${token.usdPrice}`);
        console.log(`   - Market Cap: $${token.mcap}`);
        console.log(`   - FDV: $${token.fdv}`);
        console.log(`   - Liquidity: $${token.liquidity}`);
        console.log(`   - Holders: ${token.holderCount}`);
        console.log(`   - Has audit: ${!!token.audit}`);
        console.log(`   - Has all stats: ${!!token.stats24h}`);
      } else {
        console.log('   ⚠️  No results found');
      }
    } else {
      console.log(`❌ Search endpoint FAILED: ${searchRes.status} ${searchRes.statusText}`);
    }
  } catch (err: any) {
    console.log(`❌ Search endpoint ERROR: ${err.message}`);
  }

  // Test 2: Price endpoint
  console.log('\n2. Testing PRICE endpoint (price/v3)...');
  try {
    const headers: Record<string, string> = {};
    if (JUP_API_KEY) {
      headers['x-api-key'] = JUP_API_KEY;
    }
    const priceUrl = `${JUP_PRICE_URL}?ids=${testToken}`;
    const priceRes = await fetch(priceUrl, { headers });
    
    if (priceRes.ok) {
      const priceData: any = await priceRes.json();
      console.log('✅ Price endpoint SUCCESS');
      const price = priceData?.data?.[testToken]?.price;
      if (price) {
        console.log(`   - Price: $${price}`);
      } else {
        console.log('   ⚠️  No price in response');
      }
    } else {
      console.log(`❌ Price endpoint FAILED: ${priceRes.status} ${priceRes.statusText}`);
    }
  } catch (err: any) {
    console.log(`❌ Price endpoint ERROR: ${err.message}`);
  }

  // Test 3: Batch price endpoint
  console.log('\n3. Testing BATCH PRICE endpoint (price/v3 with multiple tokens)...');
  try {
    const testTokens = [testToken, 'So11111111111111111111111111111111111111112']; // Test token + SOL
    const headers: Record<string, string> = {};
    if (JUP_API_KEY) {
      headers['x-api-key'] = JUP_API_KEY;
    }
    const batchUrl = `${JUP_PRICE_URL}?ids=${testTokens.join(',')}`;
    const batchRes = await fetch(batchUrl, { headers });
    
    if (batchRes.ok) {
      const batchData: any = await batchRes.json();
      console.log('✅ Batch price endpoint SUCCESS');
      testTokens.forEach(mint => {
        const price = batchData?.data?.[mint]?.price;
        console.log(`   - ${mint.slice(0, 8)}...: $${price || 'N/A'}`);
      });
    } else {
      console.log(`❌ Batch price endpoint FAILED: ${batchRes.status} ${batchRes.statusText}`);
    }
  } catch (err: any) {
    console.log(`❌ Batch price endpoint ERROR: ${err.message}`);
  }

  console.log('\n=== Test Complete ===\n');
}

testJupiterEndpoints().catch(console.error);

