# Market Cap Provider Optimization

## Benchmark Results

We tested different providers and methods for fetching market cap data for live signals. Here are the results:

### Fastest Methods (by avg time per token):

1. **Jupiter Search API (Parallel, 20 concurrent)**: **2.6ms/token** (26ms total for 10 tokens)
2. **Jupiter Search API (Parallel, 10 concurrent)**: 11.0ms/token (110ms total)
3. **Jupiter Search API (Sequential)**: 17.2ms/token (172ms total)
4. **Jupiter Price API (Batch)**: 20.5ms/token (205ms total) - **Supports 50 tokens per request**

### Key Findings:

1. **Jupiter Search API with 20 concurrent requests is the fastest** (2.6ms/token)
   - 4.2x faster than 10 concurrent (11ms/token)
   - 6.6x faster than sequential (17.2ms/token)
   - 7.9x faster than Price API batch (20.5ms/token)

2. **Jupiter Price API supports batch queries** (50 tokens per request)
   - Good for fetching prices in bulk
   - But doesn't return market cap directly (only price)

3. **Jupiter Search API does NOT support batch queries**
   - Must use parallel requests
   - Returns market cap directly (`mcap` field)
   - Can also calculate from `usdPrice * circSupply` if `mcap` is missing

4. **Helius DAS API** (not tested - requires API key)
   - Would need separate benchmarking with API key
   - Likely slower than Jupiter for this use case

## Optimized Implementation

The live signals code now uses:

1. **Jupiter Price API batch** (50 tokens per request) to get prices for all tokens
2. **Jupiter Search API parallel** (20 concurrent) to get market caps for tokens missing MC
   - This is the fastest method: 2.6ms/token
   - Timeout: 2 seconds per request (faster since we're doing parallel)

### Performance Impact:

For 100 signals:
- **Old approach**: ~20 signals fetched sequentially = ~340ms (17ms * 20)
- **New approach**: All 100 signals fetched in parallel batches = ~130ms (2.6ms * 50, assuming 2 batches of 50)
- **Improvement**: ~2.6x faster, and ensures ALL signals have accurate MC before sorting/filtering

## Rate Limits

- **Jupiter Search API**: No official rate limit documented, but 20 concurrent seems safe
- **Jupiter Price API**: Supports up to 50 tokens per request
- **Helius DAS API**: 2 req/sec on free plan, higher on paid plans

## Recommendations

1. ✅ **Use Jupiter Search API with 20 concurrent requests** for market cap fetching
2. ✅ **Use Jupiter Price API batch** (50 tokens) for initial price fetching
3. ✅ **Fetch market caps for ALL signals** before sorting/filtering (not just top 10)
4. ⚠️ **Monitor rate limits** - if you see 429 errors, reduce concurrency to 10

## Code Changes

Updated `src/bot/commands/analytics.ts`:
- Changed `CONCURRENCY_LIMIT` from 10 to 20
- Reduced timeout from 3s to 2s (faster since parallel)
- Added comments explaining the optimization

## ATH Calculation Optimization

### Benchmark Results for ATH:

1. **Price Samples (Database)**: **~10ms/token** (fastest, already in DB)
   - Calculates ATH from stored price samples
   - No API calls needed
   - ✅ **Recommended for live signals**

2. **GeckoTerminal OHLCV**: **1121ms/token** (too slow for live signals)
   - Requires API calls to fetch OHLCV data
   - Good for background jobs, not for live display
   - ⚠️ Only use if price samples are missing

3. **Jupiter Token Info**: No ATH data (only current price)
   - ❌ Cannot calculate ATH

4. **Bitquery OHLCV**: Not tested (requires API key)
   - Likely similar speed to GeckoTerminal

### Implementation:

For live signals top 10, we now:
1. **First**: Use stored ATH from `SignalMetric.athMultiple` (calculated by background jobs)
2. **Fallback**: Calculate ATH from price samples (fast, ~10ms, already in DB)
3. **Last resort**: Would use OHLCV APIs (too slow, only if samples missing)

### Performance:

- **Old approach**: Would need to fetch OHLCV for each token = 1121ms * 10 = 11.2 seconds
- **New approach**: Calculate from price samples = ~10ms * 10 = 100ms
- **Improvement**: ~112x faster

## Rate Limits Summary

| Provider | Method | Rate Limit | Speed |
|----------|---------|------------|-------|
| Jupiter Price API | Batch | 50 tokens/request | 17.9ms/token |
| Jupiter Search API | Parallel (20) | No official limit | **3.2ms/token** ✅ |
| Helius DAS API | Sequential | 2 req/sec (free) | Not tested |
| GeckoTerminal OHLCV | Sequential | No official limit | 1121ms/token |
| Price Samples (DB) | Direct query | N/A | **~10ms/token** ✅ |

## Testing

Run the benchmark script to test locally:
```bash
npx ts-node scripts/test_market_cap_providers.ts
```

This will test all providers and show which is fastest for your environment.

