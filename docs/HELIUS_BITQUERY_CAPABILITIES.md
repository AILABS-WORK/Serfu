# Helius & Bitquery Market Cap Capabilities

## Helius DAS API

### Market Cap Capabilities

**✅ Supports Market Cap Calculation:**
- Returns `price_per_token` (USD) and `supply` (with decimals) in one API call
- Market cap = `price_per_token * (supply / 10^decimals)`
- Available via `getAsset` or `getAssets` (batch) endpoints

**Batch Support:**
- ✅ **`getAssets` method supports batch queries** - can fetch multiple token IDs in one request
- Can handle up to 100+ token IDs per batch request (depending on plan)
- More efficient than individual `getAsset` calls

**Rate Limits:**
- Free plan: **2 req/s** for DAS API
- Developer plan: **~10 req/s**
- Pro plan: **up to 100 req/s**

**Latency:**
- Price data is **cached for 600 seconds (10 minutes)**
- Supply data is on-chain (immediate)
- API response time: ~100-300ms per request

**Pros:**
- ✅ Price + supply in one call = easy market cap calculation
- ✅ Batch support (multiple tokens per request)
- ✅ Standardized API for Solana tokens

**Cons:**
- ⚠️ Price data can be up to 10 minutes stale (cached)
- ⚠️ Rate limits may bottleneck if fetching many signals simultaneously
- ⚠️ Free plan only allows 2 req/s (would need paid plan for high throughput)

### Example Implementation

```typescript
// Batch request for multiple tokens
const response = await fetch('https://mainnet.helius-rpc.com/?api-key=YOUR_KEY', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 'batch',
    method: 'getAssets',
    params: {
      ids: ['mint1', 'mint2', 'mint3', ...], // Up to 100+ per request
    },
  }),
});

// Calculate market cap from response
const assets = response.data.result;
assets.forEach(asset => {
  const price = asset.token_info.price_info.price_per_token;
  const supply = asset.token_info.supply;
  const decimals = asset.token_info.decimals;
  const marketCap = price * (supply / Math.pow(10, decimals));
});
```

### Performance Estimate

For 100 signals:
- **Sequential (2 req/s limit)**: ~50 seconds (too slow)
- **Batch (10 tokens per batch, 2 req/s)**: ~10 seconds (still slow on free plan)
- **Batch (100 tokens per batch, 2 req/s)**: ~1 second (best case, but limited by rate limit)
- **Paid plan (100 req/s)**: Could be very fast with parallel batches

---

## Bitquery GraphQL API

### Market Cap Capabilities

**⚠️ Limited Direct Market Cap Support:**
- Provides **price data** via GraphQL queries
- Does **NOT directly provide market cap** - need to calculate from price × supply
- Supply data may need to come from separate query or another provider

**Batch Support:**
- ✅ **GraphQL supports batch queries** - can query multiple tokens in one request
- Can use `in` operator for arrays of mint addresses
- Efficient for fetching price data for multiple tokens

**Rate Limits:**
- Free plan: **10 requests/minute** (very limited)
- Paid plans: Higher limits, but specific numbers vary by tier
- Streaming endpoints available for real-time data

**Latency:**
- Price data is **very fresh** (near real-time)
- API response time: ~200-500ms per request
- GraphQL queries can be optimized for batch fetching

**Pros:**
- ✅ Very fresh price data (real-time)
- ✅ GraphQL batch queries supported
- ✅ Good for price aggregation across DEXs

**Cons:**
- ⚠️ No direct market cap field - need to calculate from price × supply
- ⚠️ Supply data may need separate query
- ⚠️ Free plan very limited (10 req/min)
- ⚠️ More complex to implement (GraphQL queries)

### Example Implementation

```typescript
// GraphQL query for multiple tokens
const query = `
  query TokenPrices($mints: [String!]!) {
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

// Note: Still need supply data from another source (Helius, Solana RPC, etc.)
```

### Performance Estimate

For 100 signals:
- **Free plan (10 req/min)**: ~10 minutes (too slow)
- **Paid plan with batch**: Could be fast, but need to combine with supply data
- **Hybrid approach**: Bitquery for price + Helius for supply = 2 API calls per token

---

## Comparison: Helius vs Bitquery vs Jupiter

| Factor | Helius | Bitquery | Jupiter |
|--------|--------|----------|---------|
| **Market Cap Direct** | ✅ Yes (price + supply) | ❌ No (price only) | ✅ Yes (mcap field) |
| **Batch Support** | ✅ Yes (getAssets) | ✅ Yes (GraphQL) | ✅ Yes (50 tokens) |
| **Price Freshness** | ⚠️ 10 min stale | ✅ Real-time | ✅ Real-time |
| **Rate Limit (Free)** | 2 req/s | 10 req/min | No official limit |
| **Speed (Free Plan)** | ~1-10s for 100 | ~10 min for 100 | **~0.2s for 100** ✅ |
| **Speed (Paid Plan)** | ~0.1-1s for 100 | ~1-5s for 100 | **~0.2s for 100** ✅ |
| **Ease of Use** | ✅ Easy | ⚠️ Complex | ✅ Easy |
| **Cost** | Free tier available | Free tier very limited | Free tier available |

---

## Recommendations

### For Live Signals (Current Implementation)

**✅ Jupiter Search API (Current Choice) - BEST**
- **Fastest**: 2.2ms/token with 20 concurrent
- **No rate limits** (or very high limits)
- **Direct market cap** in response (`mcap` field)
- **Real-time** price data
- **Free tier** available

### Alternative: Helius (If Jupiter Fails)

**✅ Helius DAS API (Good Alternative)**
- **Batch support** (can fetch 100+ tokens per request)
- **Price + supply** in one call
- **Free tier** available (but limited to 2 req/s)
- **Would need paid plan** for high throughput (100 req/s)

**Implementation:**
```typescript
// Use parallel batches of 10 tokens each
// With paid plan (100 req/s), could fetch 100 tokens in ~1-2 seconds
```

### Alternative: Bitquery (Not Recommended for Market Cap)

**⚠️ Bitquery (Not Ideal)**
- **No direct market cap** - need price + supply separately
- **Free tier too limited** (10 req/min)
- **More complex** to implement
- **Better for price-only** use cases

---

## Testing Instructions

To test Helius and Bitquery locally:

1. **Add API keys to `.env`:**
   ```
   HELIUS_API_KEY=your_helius_key
   BIT_QUERY_API_KEY=your_bitquery_key
   ```

2. **Run benchmark:**
   ```bash
   npx ts-node scripts/test_market_cap_providers.ts
   ```

3. **Compare results:**
   - Jupiter: ~2.2ms/token (20 concurrent)
   - Helius: Expected ~100-300ms per batch (depends on plan)
   - Bitquery: Expected ~200-500ms per query (depends on plan)

---

## Conclusion

**Current Implementation (Jupiter) is Optimal:**
- ✅ Fastest speed (2.2ms/token)
- ✅ No rate limit issues
- ✅ Direct market cap in response
- ✅ Real-time data
- ✅ Free tier available

**Helius would be a good fallback** if Jupiter has issues, but would require:
- Paid plan for high throughput (100 req/s)
- Handling 10-minute price cache staleness
- Batch implementation (10-100 tokens per request)

**Bitquery is not recommended** for market cap fetching due to:
- No direct market cap field
- Very limited free tier
- Need to combine with supply data from another source

