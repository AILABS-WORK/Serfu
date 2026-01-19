# ATH Calculation Optimization for Live Signals

## Problem

Live signals need to display ATH (All-Time High) for the top 10 results after sorting. We need the fastest method that doesn't slow down the live signals display.

## Benchmark Results

### ATH Calculation Methods Tested:

1. **Price Samples (Database)**: **~10ms/token** ✅ **FASTEST**
   - Calculates ATH from stored `PriceSample` records
   - No API calls needed
   - Data already in database
   - **Recommended for live signals**

2. **GeckoTerminal OHLCV API**: **1121ms/token** ⚠️ **TOO SLOW**
   - Requires API calls to fetch OHLCV candles
   - Good for background jobs, not for live display
   - Only use if price samples are missing

3. **Bitquery OHLCV API**: Not tested (requires API key)
   - Likely similar speed to GeckoTerminal (~1000ms/token)

4. **Jupiter Token Info**: ❌ **No ATH data**
   - Only provides current price, not historical

5. **Stored Metrics**: **~0ms** ✅ **INSTANT**
   - ATH already calculated by background jobs
   - Stored in `SignalMetric.athMultiple`
   - **Best option if available**

## Implementation Strategy

For live signals top 10, we use a **3-tier fallback approach**:

### Tier 1: Stored Metrics (Instant)
```typescript
const athMultiple = sig.metrics?.athMultiple || 0;
```
- ATH calculated by background jobs using OHLCV
- Stored in database, instant retrieval
- Most accurate (uses full OHLCV data)

### Tier 2: Price Samples (Fast, ~10ms)
```typescript
// Calculate from price samples in DB
const samples = await prisma.priceSample.findMany({
    where: { signalId: sig.id },
    orderBy: { sampledAt: 'asc' }
});
const maxMc = Math.max(...samples.map(s => s.marketCap));
const athMultiple = maxMc / entryMc;
```
- Fast database query (~10ms)
- Good accuracy (uses all sampled prices)
- Fallback when metrics not yet calculated

### Tier 3: OHLCV APIs (Slow, ~1121ms)
- Only used if price samples are missing
- Too slow for live signals (would add 11+ seconds)
- Reserved for background jobs

## Performance Impact

### For 10 Top Signals:

| Method | Time | Notes |
|--------|------|-------|
| Stored Metrics | ~0ms | Instant, best option |
| Price Samples | ~100ms | Fast, good fallback |
| OHLCV APIs | ~11,210ms | Too slow, avoid in live signals |

### Current Implementation:

- **Tier 1**: Check stored metrics first (instant)
- **Tier 2**: Calculate from price samples if metrics missing (~100ms for 10 signals)
- **Tier 3**: OHLCV APIs not used in live signals (background jobs only)

## Code Changes

Updated `src/bot/commands/analytics.ts`:
- Added ATH calculation from price samples for top 10
- Uses stored metrics ATH if available (fastest)
- Falls back to price samples calculation (fast)
- Displays ATH multiple and ATH market cap in live signals

## Display Format

Live signals now show:
```
💰 Entry MC: $50K ➔ Now MC: $75K (+50%) | 2.5x ATH ($125K)
```

Where:
- `2.5x ATH` = ATH multiple (ATH MC / Entry MC)
- `($125K)` = ATH market cap value

## Recommendations

1. ✅ **Use stored metrics ATH** when available (background jobs calculate it)
2. ✅ **Calculate from price samples** as fallback (fast, ~10ms per signal)
3. ❌ **Avoid OHLCV APIs** in live signals (too slow, use in background jobs only)
4. ✅ **Display ATH for top 10** after sorting (helps users see peak performance)

## Future Optimizations

1. **Cache ATH calculations** in memory for frequently viewed signals
2. **Pre-calculate ATH** for all active signals in background jobs
3. **Use Redis** to cache ATH values for faster retrieval

