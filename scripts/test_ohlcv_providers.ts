/**
 * Benchmark script to test OHLCV fetching speed from different providers
 * Tests GeckoTerminal, Bitquery, and different timeframes
 * Goal: Find fastest method for fetching ATH for multiple tokens
 */

import { geckoTerminal } from '../src/providers/geckoTerminal';
import { bitquery } from '../src/providers/bitquery';
import { logger } from '../src/utils/logger';

// Test tokens - use some real tokens that likely have OHLCV data
// Include token "g" from user's example
const TEST_MINTS = [
  '8CKUs3cXFVMaZQTeyqW6v1Lno1iS755tiWzJfbBgpump', // Token "g" from user's example (called at 11:43 PM Lisbon time at 6.4k)
  'So11111111111111111111111111111111111111112', // SOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', // ETH
  'A9mUU4qviSctJVPJdBJWkb28deg915LYJKrzQ19ji3FM', // USDCe
];

interface BenchmarkResult {
  provider: string;
  timeframe: string;
  tokens: number;
  success: number;
  failed: number;
  totalTime: number;
  avgTimePerToken: number;
  method: string;
}

async function benchmarkGeckoTerminal(mints: string[], timeframe: 'minute' | 'hour' | 'day', limit: number): Promise<BenchmarkResult> {
  const startTime = Date.now();
  let success = 0;
  let failed = 0;

  // Test parallel fetching
  const results = await Promise.allSettled(
    mints.map(async (mint) => {
      try {
        const candles = await geckoTerminal.getOHLCV(mint, timeframe, limit);
        if (candles && candles.length > 0) {
          success++;
          return candles;
        } else {
          failed++;
          return null;
        }
      } catch (err) {
        failed++;
        return null;
      }
    })
  );

  const totalTime = Date.now() - startTime;
  const avgTimePerToken = totalTime / mints.length;

  return {
    provider: 'GeckoTerminal',
    timeframe,
    tokens: mints.length,
    success,
    failed,
    totalTime,
    avgTimePerToken,
    method: 'parallel',
  };
}

async function benchmarkBitquery(mints: string[], timeframe: 'minute' | 'hour' | 'day', limit: number): Promise<BenchmarkResult> {
  const startTime = Date.now();
  let success = 0;
  let failed = 0;

  // Test parallel fetching
  const results = await Promise.allSettled(
    mints.map(async (mint) => {
      try {
        const candles = await bitquery.getOHLCV(mint, timeframe, limit);
        if (candles && candles.length > 0) {
          success++;
          return candles;
        } else {
          failed++;
          return null;
        }
      } catch (err) {
        failed++;
        return null;
      }
    })
  );

  const totalTime = Date.now() - startTime;
  const avgTimePerToken = totalTime / mints.length;

  return {
    provider: 'Bitquery',
    timeframe,
    tokens: mints.length,
    success,
    failed,
    totalTime,
    avgTimePerToken,
    method: 'parallel',
  };
}

async function benchmarkSequential(mints: string[], timeframe: 'minute' | 'hour' | 'day', limit: number): Promise<BenchmarkResult> {
  const startTime = Date.now();
  let success = 0;
  let failed = 0;

  // Test sequential fetching
  for (const mint of mints) {
    try {
      const candles = await geckoTerminal.getOHLCV(mint, timeframe, limit);
      if (candles && candles.length > 0) {
        success++;
      } else {
        failed++;
      }
    } catch (err) {
      failed++;
    }
  }

  const totalTime = Date.now() - startTime;
  const avgTimePerToken = totalTime / mints.length;

  return {
    provider: 'GeckoTerminal',
    timeframe,
    tokens: mints.length,
    success,
    failed,
    totalTime,
    avgTimePerToken,
    method: 'sequential',
  };
}

async function benchmarkBatched(mints: string[], timeframe: 'minute' | 'hour' | 'day', limit: number, batchSize: number): Promise<BenchmarkResult> {
  const startTime = Date.now();
  let success = 0;
  let failed = 0;

  // Test batched fetching
  for (let i = 0; i < mints.length; i += batchSize) {
    const batch = mints.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map(async (mint) => {
        try {
          const candles = await geckoTerminal.getOHLCV(mint, timeframe, limit);
          if (candles && candles.length > 0) {
            success++;
            return candles;
          } else {
            failed++;
            return null;
          }
        } catch (err) {
          failed++;
          return null;
        }
      })
    );
  }

  const totalTime = Date.now() - startTime;
  const avgTimePerToken = totalTime / mints.length;

  return {
    provider: 'GeckoTerminal',
    timeframe,
    tokens: mints.length,
    success,
    failed,
    totalTime,
    avgTimePerToken,
    method: `batched-${batchSize}`,
  };
}

async function runBenchmarks() {
  console.log('🚀 Starting OHLCV Provider Benchmark\n');
  console.log(`Testing ${TEST_MINTS.length} tokens...\n`);

  const results: BenchmarkResult[] = [];

  // Test 1: GeckoTerminal - Minute candles (parallel)
  console.log('Test 1: GeckoTerminal - Minute candles (parallel)...');
  results.push(await benchmarkGeckoTerminal(TEST_MINTS, 'minute', 100));

  // Test 2: GeckoTerminal - Hour candles (parallel)
  console.log('Test 2: GeckoTerminal - Hour candles (parallel)...');
  results.push(await benchmarkGeckoTerminal(TEST_MINTS, 'hour', 100));

  // Test 3: GeckoTerminal - Day candles (parallel)
  console.log('Test 3: GeckoTerminal - Day candles (parallel)...');
  results.push(await benchmarkGeckoTerminal(TEST_MINTS, 'day', 100));

  // Test 4: GeckoTerminal - Minute candles (sequential)
  console.log('Test 4: GeckoTerminal - Minute candles (sequential)...');
  results.push(await benchmarkSequential(TEST_MINTS, 'minute', 100));

  // Test 5: GeckoTerminal - Minute candles (batched 5)
  console.log('Test 5: GeckoTerminal - Minute candles (batched 5)...');
  results.push(await benchmarkBatched(TEST_MINTS, 'minute', 100, 5));

  // Test 6: GeckoTerminal - Minute candles (batched 10)
  console.log('Test 6: GeckoTerminal - Minute candles (batched 10)...');
  results.push(await benchmarkBatched(TEST_MINTS, 'minute', 100, 10));

  // Test 7: Bitquery - Minute candles (parallel)
  console.log('Test 7: Bitquery - Minute candles (parallel)...');
  try {
    results.push(await benchmarkBitquery(TEST_MINTS, 'minute', 100));
  } catch (err) {
    console.log('Bitquery test failed (likely API key missing)');
  }

  // Display results
  console.log('\n📊 Benchmark Results:\n');
  console.log('Provider | Timeframe | Method | Tokens | Success | Failed | Total (ms) | Avg/Token (ms)');
  console.log('-------- | --------- | ------ | ------ | ------- | ------ | ---------- | --------------');

  results.forEach((r) => {
    console.log(
      `${r.provider.padEnd(8)} | ${r.timeframe.padEnd(9)} | ${r.method.padEnd(6)} | ${String(r.tokens).padEnd(6)} | ${String(r.success).padEnd(7)} | ${String(r.failed).padEnd(6)} | ${String(r.totalTime).padEnd(10)} | ${r.avgTimePerToken.toFixed(2)}`
    );
  });

  // Find fastest method with at least one success
  const successfulResults = results.filter(r => r.success > 0);
  if (successfulResults.length === 0) {
    console.log('\n⚠️ No successful results found - all methods failed');
    return;
  }
  
  const fastest = successfulResults.reduce((prev, curr) => 
    curr.avgTimePerToken < prev.avgTimePerToken ? curr : prev
  );

  console.log(`\n🏆 Fastest Method: ${fastest.provider} - ${fastest.timeframe} - ${fastest.method} (${fastest.avgTimePerToken.toFixed(2)}ms/token)`);

  // Recommendations
  console.log('\n💡 Recommendations:');
  if (fastest.method === 'parallel') {
    console.log('✅ Use parallel fetching for maximum speed');
  } else if (fastest.method.startsWith('batched')) {
    const batchSize = parseInt(fastest.method.split('-')[1]);
    console.log(`✅ Use batched fetching with batch size ${batchSize} for optimal speed/rate limit balance`);
  } else {
    console.log('⚠️ Sequential is slowest - use parallel or batched');
  }

  if (fastest.timeframe === 'day') {
    console.log('✅ Day candles are fastest - use progressive timeframe strategy (day > hour > minute)');
  }
}

// Run benchmarks
runBenchmarks().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});

