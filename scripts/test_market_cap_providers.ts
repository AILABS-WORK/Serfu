/**
 * Test script to benchmark different providers for fetching market caps
 * Tests: Jupiter, Helius, and checks for batch capabilities
 */

import { getJupiterTokenInfo, getMultipleTokenPrices } from '../src/providers/jupiter';
import { logger } from '../src/utils/logger';
import fetch from 'node-fetch';

// Test mints (mix of popular and less common tokens)
const TEST_MINTS = [
  'So11111111111111111111111111111111111111112', // SOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', // mSOL
  '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', // ETH (Wormhole)
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', // BONK
  'JUPyiwrYJFskUPiHa7hkeR8VhA6hVxpRsCQ2Z4sCeE8h', // JUP
  '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', // RAY
  'A9mUU4qviSctJVPJdBJWkb28deg915LYJKrzQ19ji3FM', // UXD
  '7kbnvuGBxxj8AG9qp8Scn56muWGaRaFqxg1FsRp3PaFT', // UXLINK
];

interface BenchmarkResult {
  provider: string;
  method: string;
  totalTime: number;
  avgTimePerToken: number;
  successCount: number;
  failCount: number;
  hasBatch: boolean;
  rateLimit?: string;
}

async function testJupiterSearch(mints: string[]): Promise<BenchmarkResult> {
  const start = Date.now();
  let successCount = 0;
  let failCount = 0;
  const results: any[] = [];

  // Test sequential (current implementation)
  for (const mint of mints) {
    try {
      const info = await getJupiterTokenInfo(mint);
      if (info?.mcap) {
        results.push({ mint, mcap: info.mcap });
        successCount++;
      } else {
        failCount++;
      }
    } catch (err) {
      failCount++;
    }
  }

  const totalTime = Date.now() - start;
  return {
    provider: 'Jupiter',
    method: 'Search API (Sequential)',
    totalTime,
    avgTimePerToken: totalTime / mints.length,
    successCount,
    failCount,
    hasBatch: false,
  };
}

async function testJupiterSearchParallel(mints: string[], concurrency: number = 10): Promise<BenchmarkResult> {
  const start = Date.now();
  let successCount = 0;
  let failCount = 0;
  const results: any[] = [];

  // Test parallel with concurrency limit
  for (let i = 0; i < mints.length; i += concurrency) {
    const batch = mints.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (mint) => {
        try {
          const info = await getJupiterTokenInfo(mint);
          if (info?.mcap) {
            results.push({ mint, mcap: info.mcap });
            successCount++;
          } else {
            failCount++;
          }
        } catch (err) {
          failCount++;
        }
      })
    );
  }

  const totalTime = Date.now() - start;
  return {
    provider: 'Jupiter',
    method: `Search API (Parallel, ${concurrency} concurrent)`,
    totalTime,
    avgTimePerToken: totalTime / mints.length,
    successCount,
    failCount,
    hasBatch: false,
  };
}

async function testJupiterPriceBatch(mints: string[]): Promise<BenchmarkResult> {
  const start = Date.now();
  const priceMap = await getMultipleTokenPrices(mints);
  const totalTime = Date.now() - start;
  
  const successCount = Object.values(priceMap).filter(p => p !== null && p !== undefined).length;
  const failCount = mints.length - successCount;

  return {
    provider: 'Jupiter',
    method: 'Price API (Batch)',
    totalTime,
    avgTimePerToken: totalTime / mints.length,
    successCount,
    failCount,
    hasBatch: true,
    rateLimit: '50 tokens per request',
  };
}

async function testJupiterSearchBatch(mints: string[]): Promise<BenchmarkResult> {
  // Check if Jupiter search API supports batch queries
  const start = Date.now();
  let successCount = 0;
  let failCount = 0;

  try {
    // Try to query multiple mints in one request (comma-separated or array)
    const JUP_API_KEY = (process.env.JUPITER_API_KEY || process.env.JUP_API_KEY || '').trim() || undefined;
    const headers: Record<string, string> = {};
    if (JUP_API_KEY) {
      headers['x-api-key'] = JUP_API_KEY;
    }

    // Test 1: Comma-separated query parameter
    const queryString = mints.slice(0, 5).join(',');
    const url1 = `https://api.jup.ag/tokens/v2/search?query=${queryString}`;
    const res1 = await fetch(url1, { headers });
    
    if (res1.ok) {
      const data: any = await res1.json();
      if (Array.isArray(data) && data.length > 0) {
        successCount = data.length;
        failCount = 5 - data.length;
      } else {
        failCount = 5;
      }
    } else {
      failCount = 5;
    }

    // Test 2: Try POST with array
    const url2 = 'https://api.jup.ag/tokens/v2/search';
    const res2 = await fetch(url2, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mints: mints.slice(0, 5) }),
    });

    if (res2.ok) {
      const data: any = await res2.json();
      if (Array.isArray(data) && data.length > 0) {
        successCount = Math.max(successCount, data.length);
      }
    }
  } catch (err) {
    failCount = mints.length;
  }

  const totalTime = Date.now() - start;
  return {
    provider: 'Jupiter',
    method: 'Search API (Batch Attempt)',
    totalTime,
    avgTimePerToken: totalTime / mints.length,
    successCount,
    failCount,
    hasBatch: successCount > 0,
  };
}

async function testHeliusSequential(mints: string[]): Promise<BenchmarkResult> {
  const start = Date.now();
  let successCount = 0;
  let failCount = 0;
  const HELIUS_API_KEY = process.env.HELIUS_API_KEY || '';

  for (const mint of mints) {
    try {
      // Use Helius DAS API directly
      const url = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'test',
          method: 'getAsset',
          params: { id: mint },
        }),
      });

      if (response.ok) {
        const data: any = await response.json();
        const asset = data.result;
        if (asset?.token_info?.price_info) {
          const price = asset.token_info.price_info.price_per_token || asset.token_info.price_info.price || 0;
          const supply = asset.token_info.supply || 0;
          const decimals = asset.token_info.decimals || 9;
          const adjustedSupply = supply / Math.pow(10, decimals);
          if (price > 0 && adjustedSupply > 0) {
            successCount++;
          } else {
            failCount++;
          }
        } else {
          failCount++;
        }
      } else {
        failCount++;
      }
    } catch (err) {
      failCount++;
    }
  }

  const totalTime = Date.now() - start;
  return {
    provider: 'Helius',
    method: 'DAS API (Sequential)',
    totalTime,
    avgTimePerToken: totalTime / mints.length,
    successCount,
    failCount,
    hasBatch: false,
  };
}

async function testHeliusParallel(mints: string[], concurrency: number = 10): Promise<BenchmarkResult> {
  const start = Date.now();
  let successCount = 0;
  let failCount = 0;
  const HELIUS_API_KEY = process.env.HELIUS_API_KEY || '';

  for (let i = 0; i < mints.length; i += concurrency) {
    const batch = mints.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (mint) => {
        try {
          const url = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
          const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 'test',
              method: 'getAsset',
              params: { id: mint },
            }),
          });

          if (response.ok) {
            const data: any = await response.json();
            const asset = data.result;
            if (asset?.token_info?.price_info) {
              const price = asset.token_info.price_info.price_per_token || asset.token_info.price_info.price || 0;
              const supply = asset.token_info.supply || 0;
              const decimals = asset.token_info.decimals || 9;
              const adjustedSupply = supply / Math.pow(10, decimals);
              if (price > 0 && adjustedSupply > 0) {
                successCount++;
              } else {
                failCount++;
              }
            } else {
              failCount++;
            }
          } else {
            failCount++;
          }
        } catch (err) {
          failCount++;
        }
      })
    );
  }

  const totalTime = Date.now() - start;
  return {
    provider: 'Helius',
    method: `DAS API (Parallel, ${concurrency} concurrent)`,
    totalTime,
    avgTimePerToken: totalTime / mints.length,
    successCount,
    failCount,
    hasBatch: false,
  };
}

async function testHeliusBatch(mints: string[]): Promise<BenchmarkResult> {
  // Check if Helius DAS API supports batch getAssets
  const start = Date.now();
  let successCount = 0;
  let failCount = 0;
  const HELIUS_API_KEY = process.env.HELIUS_API_KEY || '';

  if (!HELIUS_API_KEY) {
    return {
      provider: 'Helius',
      method: 'DAS API (Batch) - No API Key',
      totalTime: 0,
      avgTimePerToken: 0,
      successCount: 0,
      failCount: mints.length,
      hasBatch: false,
    };
  }

  try {
    const url = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
    
    // Test 1: Try getAssets with array of IDs (DAS API batch)
    const testMints = mints.slice(0, 10); // Test with 10 mints
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'batch-test',
        method: 'getAssets',
        params: {
          ids: testMints,
        },
      }),
    });

    if (response.ok) {
      const data: any = await response.json();
      if (data.result && Array.isArray(data.result)) {
        // Count successful results with market cap data
        successCount = data.result.filter((asset: any) => {
          const priceInfo = asset?.token_info?.price_info;
          const supply = asset?.token_info?.supply;
          return priceInfo && supply && (priceInfo.price_per_token || priceInfo.price);
        }).length;
        failCount = testMints.length - successCount;
      } else {
        failCount = testMints.length;
      }
    } else {
      failCount = testMints.length;
    }
  } catch (err) {
    failCount = mints.length;
  }

  const totalTime = Date.now() - start;
  return {
    provider: 'Helius',
    method: 'DAS API (Batch)',
    totalTime,
    avgTimePerToken: totalTime / (mints.length || 1),
    successCount,
    failCount,
    hasBatch: successCount > 0,
    rateLimit: '2 req/s (free), up to 100 req/s (paid)',
  };
}

async function testHeliusParallelBatch(mints: string[], concurrency: number = 10): Promise<BenchmarkResult> {
  // Test Helius with parallel batch requests
  const start = Date.now();
  let successCount = 0;
  let failCount = 0;
  const HELIUS_API_KEY = process.env.HELIUS_API_KEY || '';

  if (!HELIUS_API_KEY) {
    return {
      provider: 'Helius',
      method: `DAS API (Parallel Batch, ${concurrency}) - No API Key`,
      totalTime: 0,
      avgTimePerToken: 0,
      successCount: 0,
      failCount: mints.length,
      hasBatch: false,
    };
  }

  const BATCH_SIZE = 10; // Helius can handle multiple IDs per request
  const url = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

  for (let i = 0; i < mints.length; i += BATCH_SIZE * concurrency) {
    const batches = [];
    for (let j = 0; j < concurrency && i + j * BATCH_SIZE < mints.length; j++) {
      const batchMints = mints.slice(i + j * BATCH_SIZE, i + j * BATCH_SIZE + BATCH_SIZE);
      if (batchMints.length > 0) {
        batches.push(
          fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: `batch-${j}`,
              method: 'getAssets',
              params: { ids: batchMints },
            }),
          }).then(async (res) => {
            if (res.ok) {
              const data: any = await res.json();
              if (data.result && Array.isArray(data.result)) {
                return data.result.filter((asset: any) => {
                  const priceInfo = asset?.token_info?.price_info;
                  const supply = asset?.token_info?.supply;
                  return priceInfo && supply && (priceInfo.price_per_token || priceInfo.price);
                }).length;
              }
            }
            return 0;
          }).catch(() => 0)
        );
      }
    }
    const results = await Promise.all(batches);
    successCount += results.reduce((a, b) => a + b, 0);
    failCount += (BATCH_SIZE * batches.length) - results.reduce((a, b) => a + b, 0);
  }

  const totalTime = Date.now() - start;
  return {
    provider: 'Helius',
    method: `DAS API (Parallel Batch, ${concurrency} concurrent, ${BATCH_SIZE} per batch)`,
    totalTime,
    avgTimePerToken: totalTime / mints.length,
    successCount,
    failCount,
    hasBatch: true,
    rateLimit: '2 req/s (free), up to 100 req/s (paid)',
  };
}

async function testBitqueryMarketCap(mints: string[]): Promise<BenchmarkResult> {
  // Test Bitquery for market cap data
  const start = Date.now();
  let successCount = 0;
  let failCount = 0;
  const BITQUERY_API_KEY = process.env.BIT_QUERY_API_KEY || '';

  if (!BITQUERY_API_KEY) {
    return {
      provider: 'Bitquery',
      method: 'Market Cap (No API Key)',
      totalTime: 0,
      avgTimePerToken: 0,
      successCount: 0,
      failCount: mints.length,
      hasBatch: false,
    };
  }

  // Bitquery GraphQL query for token price data
  // Note: Bitquery doesn't directly provide market cap, need to get price + supply separately
  const query = `
    query TokenPrice($mints: [String!]!) {
      Solana {
        DEXTradeByTokens(
          where: {
            Trade: {
              Currency: {
                MintAddress: {in: $mints}
              }
            }
          }
          options: {limit: 1, desc: "Block_Time"}
        ) {
          Trade {
            Currency {
              MintAddress
              Symbol
            }
            PriceInUSD: maximum(of: Trade_PriceInUSD)
          }
        }
      }
    }
  `;

  try {
    const { default: axios } = await import('axios');
    const response = await axios.post(
      'https://streaming.bitquery.io/eap',
      {
        query,
        variables: { mints: mints.slice(0, 10) }, // Test with 10
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${BITQUERY_API_KEY}`,
        },
      }
    );

    if (response.data.data?.Solana?.DEXTradeByTokens) {
      successCount = response.data.data.Solana.DEXTradeByTokens.length;
      failCount = 10 - successCount;
    } else {
      failCount = 10;
    }
  } catch (err) {
    failCount = mints.length;
  }

  const totalTime = Date.now() - start;
  return {
    provider: 'Bitquery',
    method: 'GraphQL (Price Query)',
    totalTime,
    avgTimePerToken: totalTime / (mints.length || 1),
    successCount,
    failCount,
    hasBatch: successCount > 0,
    rateLimit: '10 req/min (free), higher on paid plans',
  };
}

async function testATHProviders(mints: string[], entryDate: Date): Promise<BenchmarkResult[]> {
  const results: BenchmarkResult[] = [];
  
  // Test GeckoTerminal OHLCV (current implementation)
  console.log('\n📊 Testing ATH Calculation Methods...');
  
  // Test GeckoTerminal
  const startGecko = Date.now();
  let geckoSuccess = 0;
  let geckoFail = 0;
  
  const { geckoTerminal } = await import('../src/providers/geckoTerminal');
  for (const mint of mints.slice(0, 5)) { // Test with 5 tokens
    try {
      const candles = await geckoTerminal.getOHLCV(mint, 'minute', 100);
      if (candles && candles.length > 0) {
        const maxHigh = Math.max(...candles.map(c => c.high));
        if (maxHigh > 0) geckoSuccess++;
        else geckoFail++;
      } else {
        geckoFail++;
      }
    } catch (err) {
      geckoFail++;
    }
  }
  
  const geckoTime = Date.now() - startGecko;
  results.push({
    provider: 'GeckoTerminal',
    method: 'OHLCV (Sequential)',
    totalTime: geckoTime,
    avgTimePerToken: geckoTime / 5,
    successCount: geckoSuccess,
    failCount: geckoFail,
    hasBatch: false,
  });
  console.log(`  ✓ GeckoTerminal OHLCV: ${geckoTime}ms (${(geckoTime / 5).toFixed(1)}ms/token, ${geckoSuccess} success)`);
  
  // Test Bitquery OHLCV
  if (process.env.BIT_QUERY_API_KEY) {
    const startBitquery = Date.now();
    let bitquerySuccess = 0;
    let bitqueryFail = 0;
    
    const { bitquery } = await import('../src/providers/bitquery');
    for (const mint of mints.slice(0, 5)) {
      try {
        const candles = await bitquery.getOHLCV(mint, 'minute', 100);
        if (candles && candles.length > 0) {
          const maxHigh = Math.max(...candles.map(c => c.high));
          if (maxHigh > 0) bitquerySuccess++;
          else bitqueryFail++;
        } else {
          bitqueryFail++;
        }
      } catch (err) {
        bitqueryFail++;
      }
    }
    
    const bitqueryTime = Date.now() - startBitquery;
    results.push({
      provider: 'Bitquery',
      method: 'OHLCV (Sequential)',
      totalTime: bitqueryTime,
      avgTimePerToken: bitqueryTime / 5,
      successCount: bitquerySuccess,
      failCount: bitqueryFail,
      hasBatch: false,
    });
    console.log(`  ✓ Bitquery OHLCV: ${bitqueryTime}ms (${(bitqueryTime / 5).toFixed(1)}ms/token, ${bitquerySuccess} success)`);
  }
  
  // Test Jupiter stats24h for ATH (if available)
  const startJup = Date.now();
  let jupSuccess = 0;
  let jupFail = 0;
  
  for (const mint of mints.slice(0, 5)) {
    try {
      const info = await getJupiterTokenInfo(mint);
      // Jupiter doesn't provide historical ATH, but stats24h has price change
      // We'd need OHLCV for true ATH
      if (info) {
        jupSuccess++; // Just checking if data is available
      } else {
        jupFail++;
      }
    } catch (err) {
      jupFail++;
    }
  }
  
  const jupTime = Date.now() - startJup;
  results.push({
    provider: 'Jupiter',
    method: 'Token Info (No ATH)',
    totalTime: jupTime,
    avgTimePerToken: jupTime / 5,
    successCount: jupSuccess,
    failCount: jupFail,
    hasBatch: false,
    rateLimit: 'No ATH data available',
  });
  console.log(`  ✗ Jupiter: No ATH data (only current price)`);
  
  return results;
}

async function runBenchmarks() {
  console.log('🚀 Starting Market Cap Provider Benchmarks\n');
  console.log(`Testing with ${TEST_MINTS.length} tokens\n`);
  console.log('='.repeat(80));

  const results: BenchmarkResult[] = [];

  // Test Jupiter methods
  console.log('\n📊 Testing Jupiter Provider...');
  try {
    const jupPriceBatch = await testJupiterPriceBatch(TEST_MINTS);
    results.push(jupPriceBatch);
    console.log(`  ✓ Price Batch: ${jupPriceBatch.totalTime}ms (${jupPriceBatch.avgTimePerToken.toFixed(1)}ms/token, ${jupPriceBatch.successCount} success)`);

    const jupSearchSeq = await testJupiterSearch(TEST_MINTS);
    results.push(jupSearchSeq);
    console.log(`  ✓ Search Sequential: ${jupSearchSeq.totalTime}ms (${jupSearchSeq.avgTimePerToken.toFixed(1)}ms/token, ${jupSearchSeq.successCount} success)`);

    const jupSearchPar10 = await testJupiterSearchParallel(TEST_MINTS, 10);
    results.push(jupSearchPar10);
    console.log(`  ✓ Search Parallel (10): ${jupSearchPar10.totalTime}ms (${jupSearchPar10.avgTimePerToken.toFixed(1)}ms/token, ${jupSearchPar10.successCount} success)`);

    const jupSearchPar20 = await testJupiterSearchParallel(TEST_MINTS, 20);
    results.push(jupSearchPar20);
    console.log(`  ✓ Search Parallel (20): ${jupSearchPar20.totalTime}ms (${jupSearchPar20.avgTimePerToken.toFixed(1)}ms/token, ${jupSearchPar20.successCount} success)`);

    const jupSearchBatch = await testJupiterSearchBatch(TEST_MINTS);
    results.push(jupSearchBatch);
    console.log(`  ${jupSearchBatch.hasBatch ? '✓' : '✗'} Search Batch: ${jupSearchBatch.totalTime}ms (${jupSearchBatch.successCount > 0 ? 'SUPPORTED' : 'NOT SUPPORTED'})`);
  } catch (err) {
    console.error('  ✗ Jupiter tests failed:', err);
  }

  // Test Helius methods
  console.log('\n📊 Testing Helius Provider...');
  try {
    if (process.env.HELIUS_API_KEY) {
      const heliusSeq = await testHeliusSequential(TEST_MINTS);
      results.push(heliusSeq);
      console.log(`  ✓ Sequential: ${heliusSeq.totalTime}ms (${heliusSeq.avgTimePerToken.toFixed(1)}ms/token, ${heliusSeq.successCount} success)`);

      const heliusPar10 = await testHeliusParallel(TEST_MINTS, 10);
      results.push(heliusPar10);
      console.log(`  ✓ Parallel (10): ${heliusPar10.totalTime}ms (${heliusPar10.avgTimePerToken.toFixed(1)}ms/token, ${heliusPar10.successCount} success)`);

      const heliusPar20 = await testHeliusParallel(TEST_MINTS, 20);
      results.push(heliusPar20);
      console.log(`  ✓ Parallel (20): ${heliusPar20.totalTime}ms (${heliusPar20.avgTimePerToken.toFixed(1)}ms/token, ${heliusPar20.successCount} success)`);

      const heliusBatch = await testHeliusBatch(TEST_MINTS);
      results.push(heliusBatch);
      console.log(`  ${heliusBatch.hasBatch ? '✓' : '✗'} Batch: ${heliusBatch.totalTime}ms (${heliusBatch.successCount > 0 ? 'SUPPORTED' : 'NOT SUPPORTED'})`);

      const heliusParBatch = await testHeliusParallelBatch(TEST_MINTS, 5);
      results.push(heliusParBatch);
      console.log(`  ${heliusParBatch.hasBatch ? '✓' : '✗'} Parallel Batch (5): ${heliusParBatch.totalTime}ms (${heliusParBatch.avgTimePerToken.toFixed(1)}ms/token, ${heliusParBatch.successCount} success)`);
    } else {
      console.log('  ⚠️  Skipping Helius tests (no HELIUS_API_KEY in environment)');
    }
  } catch (err) {
    console.error('  ✗ Helius tests failed:', err);
  }

  // Test Bitquery methods
  console.log('\n📊 Testing Bitquery Provider...');
  try {
    if (process.env.BIT_QUERY_API_KEY) {
      const bitqueryMc = await testBitqueryMarketCap(TEST_MINTS);
      results.push(bitqueryMc);
      console.log(`  ${bitqueryMc.hasBatch ? '✓' : '✗'} Market Cap Query: ${bitqueryMc.totalTime}ms (${bitqueryMc.avgTimePerToken.toFixed(1)}ms/token, ${bitqueryMc.successCount} success)`);
    } else {
      console.log('  ⚠️  Skipping Bitquery tests (no BIT_QUERY_API_KEY in environment)');
    }
  } catch (err) {
    console.error('  ✗ Bitquery tests failed:', err);
  }

  // Summary
  console.log('\n' + '='.repeat(80));
  console.log('\n📈 BENCHMARK SUMMARY\n');
  console.log('Fastest Methods (by avg time per token):');
  results
    .sort((a, b) => a.avgTimePerToken - b.avgTimePerToken)
    .slice(0, 5)
    .forEach((r, i) => {
      console.log(`  ${i + 1}. ${r.provider} - ${r.method}: ${r.avgTimePerToken.toFixed(1)}ms/token (${r.totalTime}ms total)`);
    });

  console.log('\nBatch Support:');
  results
    .filter(r => r.hasBatch)
    .forEach(r => {
      console.log(`  ✓ ${r.provider} - ${r.method} ${r.rateLimit ? `(${r.rateLimit})` : ''}`);
    });

  if (results.filter(r => r.hasBatch).length === 0) {
    console.log('  ✗ No batch support found - using parallel requests');
  }

  // Test ATH calculation methods
  const entryDate = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24h ago
  const athResults = await testATHProviders(TEST_MINTS, entryDate);
  results.push(...athResults);

  console.log('\n' + '='.repeat(80));
  console.log('\n📈 ATH CALCULATION SUMMARY\n');
  console.log('Fastest ATH Methods:');
  athResults
    .sort((a, b) => a.avgTimePerToken - b.avgTimePerToken)
    .forEach((r, i) => {
      console.log(`  ${i + 1}. ${r.provider} - ${r.method}: ${r.avgTimePerToken.toFixed(1)}ms/token (${r.totalTime}ms total, ${r.successCount} success)`);
    });

  console.log('\n✅ Benchmark complete!\n');
}

// Run if executed directly
if (require.main === module) {
  runBenchmarks().catch(console.error);
}

export { runBenchmarks };

