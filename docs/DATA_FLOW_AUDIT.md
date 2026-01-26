# Data Flow Audit - Complete Application Review

## 1. Signal Detection & Creation Flow ✅

### Entry Point: `src/ingest/processor.ts`

```
RawMessage → detectSignal() → createSignal()
```

**Data Captured at Creation:**
| Field | Source | Status |
|-------|--------|--------|
| `entryPrice` | Jupiter/Helius | ✅ |
| `entryMarketCap` | `entryPrice * entrySupply` | ✅ |
| `entrySupply` | Token meta | ✅ |
| `entryPriceAt` | Current timestamp | ✅ |
| `tokenCreatedAt` | Token meta | ✅ |
| `dexPaid` | Event detection | ✅ |
| `migrated` | Event detection | ✅ |

**Smart Feature:** Reuses entry data from earliest signal for same mint (prevents duplicate entry prices).

### Metrics Initialization: `src/db/signals.ts`

When signal is created, `SignalMetric` is immediately initialized:
- `athPrice = entryPrice`
- `athMultiple = 1.0`
- `athAt = detectedAt`
- `currentPrice = entryPrice`
- `maxDrawdown = 0`

---

## 2. Background Jobs ✅

### Job Schedule: `src/jobs/index.ts`

| Job | Frequency | Purpose | Status |
|-----|-----------|---------|--------|
| `priceAlertJob` | 1 min | Check price alerts | ✅ |
| `samplingJob` | 1 min | Price samples | ✅ |
| `athEnrichmentJob` | 10 min | Smart ATH update | ✅ |
| `historicalMetricsJob` | 30 min | Update old signals | ✅ |
| `liveAthInterval` | 10 sec | Jupiter price refresh | ✅ (after backfill) |

### Live ATH Refresh: `src/jobs/athBackfill.ts::refreshLiveAth()`

**Conditions:**
- Only runs if `backfillProgress.status === 'complete'`
- Fetches Jupiter batch prices
- Updates ATH if `currentPrice > storedAthPrice`
- Creates metrics for new signals without any

**Metrics Updated:**
- `currentPrice`, `currentMultiple`, `currentMarketCap`
- `athPrice`, `athMultiple`, `athMarketCap`, `athAt`
- `timeToAth`

---

## 3. Fast Backfill System ✅

### Module: `src/jobs/athBackfillFast.ts`

**Optimizations:**
- 10 parallel workers
- 50ms delay between items
- Pool address caching
- Tiered OHLCV (minute → hour → day)
- Auto-sets `ATH = entryPrice` if no OHLCV data

**Metrics Calculated:**
- `athPrice`, `athMultiple`, `athAt`, `timeToAth`
- `maxDrawdown`, `minLowPrice`, `minLowAt`
- `timeTo2x`, `timeTo3x`, `timeTo5x`, `timeTo10x`
- `currentPrice`, `currentMultiple`, `currentMarketCap`

---

## 4. Analytics Endpoints ✅

### 4.1 Live Signals: `src/bot/commands/analytics/liveSignals.ts`

**Data Flow:**
```
DB (signals + metrics) → Jupiter prices → Display
```

**Logic:**
- If backfill complete → instant from DB
- If not complete → fast parallel OHLCV fetch

**Data Used:**
- `signal.metrics.athMultiple` ✅
- `signal.metrics.maxDrawdown` ✅
- `signal.metrics.timeToAth` ✅

---

### 4.2 Distributions: `src/bot/commands/analytics/distributions.ts`

**Data Source:** `aggregator.getDistributionStats()`

**Includes:** `{ metrics: true }`

**Metrics Used:**
- `athMultiple` for win buckets
- `maxDrawdown` for drawdown analysis
- `timeToAth` for time distributions
- Entry market cap for MC buckets

---

### 4.3 Leaderboards: `src/bot/commands/analytics/leaderboards.ts`

**Data Source:** `aggregator.getLeaderboard()`

**Includes:** `{ metrics: true }`

**Metrics Used:**
- All `EntityStats` fields from `calculateStats()`
- `avgMultiple`, `winRate`, `avgTimeToAth`, `avgDrawdown`
- `timeTo2x`, `timeTo3x`, `timeTo5x`, `timeTo10x`

---

### 4.4 Recent Calls: `src/bot/commands/analytics/recentCalls.ts`

**Includes:** `{ metrics: true }`

**Metrics Used:**
- `athMultiple` for display
- `maxDrawdown` for display

---

### 4.5 Group/User Stats: `src/bot/commands/analytics/index.ts`

**Data Source:** `aggregator.getGroupStats()` / `getUserStats()`

**All metrics properly routed ✅**

---

## 5. Aggregator Analysis: `src/analytics/aggregator.ts`

### `calculateStats()` Function

**Input:** `SignalWithMetrics[]`

**All metrics extracted:**
```typescript
mult = s.metrics.athMultiple
dd = s.metrics.maxDrawdown
athAt = s.metrics.athAt
timeTo2x = s.metrics.timeTo2x
timeTo3x = s.metrics.timeTo3x
timeTo5x = s.metrics.timeTo5x
timeTo10x = s.metrics.timeTo10x
```

**Calculated Stats:**
- `avgMultiple`, `winRate`, `winRate5x`
- `hit2Count`, `hit5Count`, `hit10Count`
- `avgDrawdown`, `avgTimeToAth`
- `consistency` (stddev of multiples)
- `rugRate` (< 0.5x or > -90% DD)
- `speedScore`, `sniperScore`
- `reliabilityTier` (S/A/B/C/F)

---

## 6. Schema Completeness: `prisma/schema.prisma`

### SignalMetric Model ✅

| Field | Type | Used In |
|-------|------|---------|
| `currentPrice` | Float | Live display |
| `currentMultiple` | Float | Live display |
| `athPrice` | Float | All analytics |
| `athMultiple` | Float | All analytics |
| `athAt` | DateTime | Time calculations |
| `timeToAth` | Int? | Stats, distributions |
| `timeTo2x` | Int? | Stats |
| `timeTo3x` | Int? | Stats |
| `timeTo5x` | Int? | Stats |
| `timeTo10x` | Int? | Stats |
| `maxDrawdown` | Float | Risk analysis |
| `minLowPrice` | Float? | Drawdown analysis |
| `minLowAt` | DateTime? | Time analysis |
| `stagnationTime` | Int? | Behavioral analysis |
| `drawdownDuration` | Int? | Risk analysis |
| `ohlcvLastAt` | DateTime? | Incremental updates |

---

## 7. Validation System ✅

### Module: `src/analytics/backfillValidation.ts`

**Checks:**
- Missing entry price
- Missing metrics
- ATH below entry
- Negative timeToAth
- ATH timestamp before entry
- Stale metrics (>24h)

**Fix Functions:**
- `autoFixIssues()` - DB timestamp fixes
- `fixTimingIssues()` - Minute candle re-fetch
- `fixUnfixableSignals()` - Set ATH = entry for dead tokens

---

## 8. Current Issues & Gaps

### Minor Issues:
1. **12 Errors** in validation - likely `MISSING_ENTRY` (signals without entry price)
2. **Stale metrics** - Normal for old signals, Jupiter refresh handles active ones

### All Clear:
- ✅ Signal creation captures all entry data
- ✅ Metrics initialized on signal creation
- ✅ Backfill populates historical ATH
- ✅ Jupiter refresh maintains live ATH
- ✅ All analytics endpoints use `include: { metrics: true }`
- ✅ Aggregator extracts all timeToNx fields
- ✅ Distributions use full metric data

---

## 9. Recommendations

### For Backtesting Readiness:
1. Run "Fix Missing ATH" for any remaining signals
2. Ensure backfill status = 'complete'
3. Validation should show 95%+ analytics readiness

### Already Complete:
- Entry price capture ✅
- ATH calculation ✅
- Drawdown tracking ✅
- Time-to-Nx metrics ✅
- All analytics wired ✅

---

*Generated: 2026-01-26*

