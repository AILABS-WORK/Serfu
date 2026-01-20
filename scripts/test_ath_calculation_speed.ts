/**
 * Benchmark script to test ATH calculation speed for multiple tokens
 * Tests different OHLCV methods and providers to find the fastest approach
 */

import { geckoTerminal } from '../src/providers/geckoTerminal';
import axios from 'axios';

// Test tokens (use real mints for testing)
const TEST_TOKENS = [
    'So11111111111111111111111111111111111111112', // SOL (for testing pool finding)
    // Add more test tokens here
];

const GECKO_BASE_URL = 'https://api.geckoterminal.com/api/v2';
const DEXSCREENER_BASE_URL = 'https://api.dexscreener.com/latest/dex/tokens';

interface TestResult {
    method: string;
    timeframe: 'minute' | 'hour' | 'day';
    tokens: number;
    totalTime: number;
    avgTimePerToken: number;
    success: number;
    failed: number;
    errors: string[];
}

async function findPoolAddress(mint: string): Promise<string | null> {
    try {
        // Try GeckoTerminal first
        const geckoUrl = `${GECKO_BASE_URL}/networks/solana/tokens/${mint}/pools`;
        const geckoResponse = await axios.get(geckoUrl, {
            params: { page: 1, limit: 1 },
            timeout: 5000
        });
        
        const pools = geckoResponse.data?.data;
        if (pools && pools.length > 0) {
            return pools[0].attributes.address;
        }
        
        // Fallback to DexScreener
        const dexUrl = `${DEXSCREENER_BASE_URL}/${mint}`;
        const dexResponse = await axios.get(dexUrl, { timeout: 5000 });
        const pairs = dexResponse.data?.pairs;
        
        if (pairs && pairs.length > 0) {
            return pairs[0].pairAddress;
        }
        
        return null;
    } catch (err) {
        return null;
    }
}

async function fetchOHLCV_Gecko(mint: string, timeframe: 'minute' | 'hour' | 'day', limit: number): Promise<any[]> {
    try {
        const poolAddress = await findPoolAddress(mint);
        if (!poolAddress) return [];
        
        const url = `${GECKO_BASE_URL}/networks/solana/pools/${poolAddress}/ohlcv/${timeframe}`;
        const response = await axios.get(url, {
            params: { limit },
            timeout: 10000
        });
        
        const list = response.data?.data?.attributes?.ohlcv_list;
        if (!Array.isArray(list)) return [];
        
        return list.map((item: any[]) => ({
            timestamp: item[0] * 1000,
            open: item[1],
            high: item[2],
            low: item[3],
            close: item[4],
            volume: item[5]
        })).reverse();
    } catch (err) {
        return [];
    }
}

async function fetchOHLCV_GeckoDirect(mint: string, timeframe: 'minute' | 'hour' | 'day', limit: number): Promise<any[]> {
    // Use the geckoTerminal provider directly
    return await geckoTerminal.getOHLCV(mint, timeframe, limit);
}

async function fetchOHLCV_DexScreener(mint: string): Promise<any[]> {
    try {
        const url = `${DEXSCREENER_BASE_URL}/${mint}`;
        const response = await axios.get(url, { timeout: 10000 });
        const pairs = response.data?.pairs;
        
        if (!pairs || pairs.length === 0) return [];
        
        // DexScreener doesn't have direct OHLCV, but we can use price history if available
        // For now, return empty - DexScreener is better for metadata than OHLCV
        return [];
    } catch (err) {
        return [];
    }
}

async function testMethod(
    tokens: string[],
    method: string,
    timeframe: 'minute' | 'hour' | 'day',
    limit: number
): Promise<TestResult> {
    const startTime = Date.now();
    let success = 0;
    let failed = 0;
    const errors: string[] = [];
    
    // Test sequential (current approach)
    if (method.includes('sequential')) {
        for (const mint of tokens) {
            try {
                let candles: any[] = [];
                if (method.includes('gecko-provider')) {
                    candles = await fetchOHLCV_GeckoDirect(mint, timeframe, limit);
                } else if (method.includes('gecko-direct')) {
                    candles = await fetchOHLCV_Gecko(mint, timeframe, limit);
                }
                
                if (candles && candles.length > 0) {
                    success++;
                } else {
                    failed++;
                    errors.push(`${mint}: No candles returned`);
                }
            } catch (err: any) {
                failed++;
                errors.push(`${mint}: ${err.message || 'Unknown error'}`);
            }
        }
    }
    
    // Test parallel (batch approach)
    if (method.includes('parallel')) {
        const promises = tokens.map(async (mint) => {
            try {
                let candles: any[] = [];
                if (method.includes('gecko-provider')) {
                    candles = await fetchOHLCV_GeckoDirect(mint, timeframe, limit);
                } else if (method.includes('gecko-direct')) {
                    candles = await fetchOHLCV_Gecko(mint, timeframe, limit);
                }
                
                if (candles && candles.length > 0) {
                    return { success: true, mint };
                } else {
                    return { success: false, mint, error: 'No candles' };
                }
            } catch (err: any) {
                return { success: false, mint, error: err.message || 'Unknown error' };
            }
        });
        
        const results = await Promise.all(promises);
        for (const result of results) {
            if (result.success) {
                success++;
            } else {
                failed++;
                errors.push(`${result.mint}: ${result.error}`);
            }
        }
    }
    
    const totalTime = Date.now() - startTime;
    
    return {
        method,
        timeframe,
        tokens: tokens.length,
        totalTime,
        avgTimePerToken: totalTime / tokens.length,
        success,
        failed,
        errors
    };
}

async function runBenchmarks() {
    console.log('🚀 Starting ATH Calculation Speed Benchmark\n');
    
    // Get test tokens from command line or use defaults
    const testTokens = process.argv.slice(2).length > 0 
        ? process.argv.slice(2) 
        : TEST_TOKENS;
    
    if (testTokens.length === 0) {
        console.log('❌ No test tokens provided. Usage: npm run test:ath <mint1> <mint2> ...');
        process.exit(1);
    }
    
    console.log(`📊 Testing with ${testTokens.length} tokens\n`);
    
    const results: TestResult[] = [];
    
    // Test configurations
    const configs = [
        { method: 'sequential-gecko-provider', timeframe: 'minute' as const, limit: 1000 },
        { method: 'parallel-gecko-provider', timeframe: 'minute' as const, limit: 1000 },
        { method: 'sequential-gecko-provider', timeframe: 'hour' as const, limit: 1000 },
        { method: 'parallel-gecko-provider', timeframe: 'hour' as const, limit: 1000 },
        { method: 'sequential-gecko-provider', timeframe: 'day' as const, limit: 1000 },
        { method: 'parallel-gecko-provider', timeframe: 'day' as const, limit: 1000 },
        { method: 'sequential-gecko-direct', timeframe: 'minute' as const, limit: 1000 },
        { method: 'parallel-gecko-direct', timeframe: 'minute' as const, limit: 1000 },
    ];
    
    for (const config of configs) {
        console.log(`Testing: ${config.method} with ${config.timeframe} candles (limit: ${config.limit})...`);
        const result = await testMethod(testTokens, config.method, config.timeframe, config.limit);
        results.push(result);
        
        console.log(`  ✅ Success: ${result.success}/${result.tokens}`);
        console.log(`  ⏱️  Total: ${result.totalTime}ms | Avg: ${result.avgTimePerToken.toFixed(2)}ms/token\n`);
        
        // Small delay between tests to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    // Sort by avg time per token
    results.sort((a, b) => a.avgTimePerToken - b.avgTimePerToken);
    
    console.log('\n📈 Results Summary (sorted by speed):\n');
    console.log('Method'.padEnd(30) + 'Timeframe'.padEnd(12) + 'Avg Time/token'.padEnd(18) + 'Success Rate');
    console.log('-'.repeat(80));
    
    for (const result of results) {
        const successRate = ((result.success / result.tokens) * 100).toFixed(0) + '%';
        console.log(
            result.method.padEnd(30) +
            result.timeframe.padEnd(12) +
            `${result.avgTimePerToken.toFixed(2)}ms`.padEnd(18) +
            successRate
        );
    }
    
    console.log('\n🏆 Fastest Method:', results[0].method, `(${results[0].timeframe}) - ${results[0].avgTimePerToken.toFixed(2)}ms/token`);
    
    // Recommendations
    console.log('\n💡 Recommendations:');
    const fastestParallel = results.find(r => r.method.includes('parallel'));
    if (fastestParallel) {
        console.log(`  - Use parallel fetching for batch operations: ${fastestParallel.avgTimePerToken.toFixed(2)}ms/token`);
    }
    
    const fastestTimeframe = results.reduce((prev, curr) => 
        curr.avgTimePerToken < prev.avgTimePerToken ? curr : prev
    );
    console.log(`  - Fastest timeframe: ${fastestTimeframe.timeframe} (${fastestTimeframe.avgTimePerToken.toFixed(2)}ms/token)`);
}

runBenchmarks().catch(console.error);

