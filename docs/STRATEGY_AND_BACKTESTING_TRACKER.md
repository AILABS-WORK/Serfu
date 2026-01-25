# Strategy & Backtesting Implementation Tracker

Purpose: single source of truth for all analytics, metrics, backtesting, and
copy‑trading strategy work required to reach a fully data‑driven system.

Owner: Serfu Analytics Bot
Status: Active

---

## 1) Goals
- Use historical calls to learn which signals, times, market caps, and sources
  are most profitable.
- Convert analytics into actionable copy‑trading strategies (entry/TP/SL rules).
- Keep ATH/Drawdown metrics accurate and up‑to‑date with minimal API load.
- Make every analytics view consistent: Live Signals, Recent Calls, Leaderboards,
  Distributions, Strategy Reports.

---

## 2) Data Sources (Current)
- **Signals**: `signals` table (entryPrice, entryMarketCap, entryPriceAt).
- **Price Samples**: `price_samples` (periodic snapshots).
- **Metrics**: `signal_metrics` (ATH, drawdown, time‑to‑X).
- **Threshold Events**: `threshold_events` (2x/3x/5x/10x hits).
- **Providers**: Jupiter (current price), GeckoTerminal (OHLCV).

---

## 3) Metric Definitions (Single‑Source Truth)
All metrics must use `entryPriceAt` when present; fallback to `detectedAt`.

Core signal metrics:
- **ATH Price / Multiple / Market Cap**
- **Max Drawdown** (negative % from entry to lowest low before ATH)
- **Time to ATH** (ms from entry to ATH)
- **Time From DD to ATH** (ms from lowest low to ATH)
- **Time to 2x/3x/5x/10x** (ms, from entry)
- **Stagnation Time** (time spent <1.1x before pumping)
- **Drawdown Duration** (time underwater before ATH)

Entity metrics (group/user):
- Avg ATH multiple, win rate (>= threshold), moon rate (>5x)
- Avg drawdown, avg time to ATH, time‑to‑2x/5x/10x
- Avg entry MC, avg ATH MC
- Consistency / volatility index / risk score / reliability tier

Distribution metrics:
- Entry market cap buckets
- Time of day / day of week
- Confluence (multi‑group confirms)
- Liquidity/volume buckets (if available)
- Token age buckets (if creation timestamps available)

---

## 4) Known Gaps / Fixes Needed
- **Entry time alignment** across all metrics jobs and aggregators.
- **Drawdown units** standardized (store and display as percent everywhere).
- **Aggregator consistency** (avoid Bitquery refresh unless explicitly enabled).
- **Metrics completeness checks** so stale/empty metrics are rebuilt.
- **Backtesting engine** does not exist yet.

---

## 5) Analytics Views: Required Inputs

Live Signals:
- Must show accurate ATH, Max DD, Time to ATH, DD→ATH.
- Must use current price + cached metrics; incremental OHLCV updates.

Recent Calls:
- Must use latest metrics, avoid stale values.
- Must display entry MC, ATH MC, drawdown, time‑to‑X.

Leaderboards:
- Group/User: uses same aggregated stats computed from metrics.
- Signals: uses ATH multiple + correct time‑to‑ATH and drawdown.

Distributions:
- Entry MC buckets, time of day, day of week, confluence,
  token age, liquidity/volume.

Strategy Report:
- Derived from distributions + backtesting results.

---

## 6) Strategy + Backtesting Framework

### 6.1 Strategy inputs (per source / group / segment)
- Entry MC bucket
- Time of day
- Group / user / confluence level
- Recent performance window (7D/30D/ALL)

### 6.2 Strategy outputs
- Recommended action: Copy / Avoid / Manual
- Stop loss % (optimized)
- Take profit ladder (TP1/TP2/TP3)
- Hold time bias (scalp vs swing)
- Risk tier

### 6.3 Backtesting engine (to build)
Inputs:
- Signal entry price/time
- Price samples or OHLCV
- TP/SL rules
- Time window or max hold

Outputs:
- ROI %
- Max drawdown
- Time to TP/SL
- Win rate and expectancy

---

## 7) Background Jobs Plan

ATH/Drawdown Incremental:
- Use `ohlcv_last_at` to fetch only new candles.
- Update `min_low_price` + `min_low_at` for DD tracking.

Historical Metrics Sweep:
- Backfill missing ATH/Drawdown/Times for recent signals.
- Only re‑check stale or missing metrics.

Sampling Job:
- Keep price_samples fresh for fallback metrics.

Aggregation Job:
- Recompute group/user/category metrics per window (7D/30D/ALL).
- Uses normalized metrics only (no provider calls).

---

## 8) Implementation Checklist

### Phase 1 — Normalization
- [x] Standardize drawdown units (percent everywhere).
- [x] Use `entryPriceAt` as entry time in all computations.
- [x] Add “metrics completeness” helper and use in metrics jobs.

### Phase 2 — Aggregators
- [x] Remove Bitquery refresh from aggregators (GeckoTerminal only).
- [x] Fix group/user metric functions (sorting bug, time windows).
- [x] Align distributions with normalized metrics.

### Phase 3 — Background Metrics
- [x] Incremental OHLCV cursor used for ATH/drawdown updates.
- [x] Update historical sweep to use entry time and cursors.
- [x] Add “needs ATH refresh” selector (current price > ATH threshold).

### Phase 4 — Backtesting
- [x] Implement backtest engine (price_samples + OHLCV).
- [x] Strategy optimizer (TP/SL grid) for auto strategies.
- [x] Integrate into Strategy Report UI.

### Phase 5 — UI Consistency
- [x] Live Signals uses stored ATH/Times with correct entry basis.
- [x] Recent Calls/Leaderboards show matching metric definitions.
- [x] Distributions add confluence + time‑of‑day insights.

---

## 9) Validation Checklist
- ATH and Time to ATH are consistent with entry time.
- Max DD never after ATH.
- Distributions and leaderboards match Live Signals values.
- Backtest stats match manual sample checks.

---

## 10) Strategy Insights (Target Output)
- Best time windows (hour/day) to trade.
- Best entry MC buckets to target.
- Best groups/users by confluence.
- Optimal TP/SL rules per segment.
- Expected ROI and win rate by segment.

