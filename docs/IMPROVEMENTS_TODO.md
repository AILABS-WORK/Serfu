# Serfu App Improvements & Fixes (Detailed)

This document lists what must be improved or fixed in the app based on current UI results and deployment logs. It is organized by area, with exact symptoms, likely causes, and required actions.

---

## 1) Live Signals

### 1.1 Entry MC missing unless sorted by "Newest"
- **Symptom:** Entry MC is `N/A` for many rows unless the user switches to "Newest".
- **Likely cause:** Entry MC is missing for many signals and only becomes available after sampling or when the list is rebuilt with newer signals.
- **Fix required:**
  - Ensure `ENTRY_PENDING` signals are sampled and promoted to `ACTIVE` (already addressed in `runSamplingCycle`).
  - Backfill `entryMarketCap` for older signals (first sample market cap → entry MC).
  - Add a **manual backfill action** in bot to force backfill for a set of signals (see Section 7.2).

### 1.2 Filters (2x/5x/Gainers) not working reliably
- **Symptom:** Filters show "No signals match your filters" even when signals show >2x or >5x elsewhere.
- **Likely cause:** Filter logic uses PnL% and missing entry/current MC instead of actual multiples.
- **Fix required:**
  - Filter on `currentMultiple` derived from current MC / entry MC.
  - Keep fallback to `metrics.currentMultiple` when entry/current MC are missing.
  - Ensure UI always displays the multiple next to MC delta.

### 1.3 Live Signals missing DEX paid / migrated / CTO status
- **Symptom:** Rows often show ❌ for Dex/Migrated/Team even when token meta shows otherwise.
- **Likely cause:** Signal ingestion relies only on parsed message events; meta lookup data is not applied to flags.
- **Fix required:**
  - Use Jupiter metadata (audit + socials) when available to infer:
    - `migrated` → use audit/launchpad or pool metadata if provided.
    - `dexPaid` → if not detected from message, leave unknown instead of ❌ (avoid misleading false negatives).
    - `team/CTO` → infer from `audit.devBalancePercentage` and social presence.
  - Update Live Signals UI to show **Unknown** when not determinable.

### 1.4 ATH visibility for each live signal
- **Symptom:** No visible ATH since entry.
- **Fix required:**
  - Display ATH multiple and ATH MC (from `signal.metrics.athMultiple` and `athMarketCap`).
  - Provide a quick “ATH since entry” line in Live Signals or add a button to show detail.

---

## 2) Recent Calls / Activity Log

### 2.1 Time-to-2x/5x/10x missing even for 5.78x signals
- **Symptom:** Time-to-X shows `N/A` despite high ATH multiple.
- **Root cause:** `updateHistoricalMetrics` only wrote ATH/drawdown, not time-to-X.
- **Fix required:**
  - Backfill `timeTo2x/5x/10x` using OHLCV candle history between entry and now.
  - Store time-to-X into `signal_metrics` for use in recent calls.
  - Ensure the metrics job runs successfully (see Section 6 – Bitquery 401).

### 2.2 ATH MC in Recent Calls
- **Symptom:** ATH MC not always shown.
- **Fix required:**
  - Use `signal.metrics.athMarketCap` or compute from historical candles if missing.
  - Display ATH MC and ATH multiple on Recent Calls cards.

---

## 3) Group Analytics & Leaderboards

### 3.1 Avg entry MC and avg ATH MC incorrect / missing
- **Symptom:** Avg entry MC looks wrong; avg ATH MC missing.
- **Root cause:** Entry MC not reliably stored for all signals; ATH MC not stored if only price based.
- **Fix required:**
  - Backfill entry MC using first market-cap sample.
  - Backfill ATH MC using historical candles if only `athPrice` exists.
  - Update aggregation to use these fields (fallbacks in place).

### 3.2 Avg time-to-X and time-to-ATH incomplete
- **Symptom:** Avg time-to-2x/5x/10x remains N/A in group analytics.
- **Root cause:** Time-to-X stored only during live sampling; historical backfill missing.
- **Fix required:**
  - Ensure historical backfill writes time-to-X.
  - Re-run backfill across recent signals for a complete dataset.

### 3.3 Drawdown & drawdown duration
- **Symptom:** Avg drawdown exists but time in drawdown not visible.
- **Fix required:**
  - Surface `avgDrawdownDuration` in group stats.
  - Add “time underwater before ATH” and “time to ATH after drawdown” indicators.

### 3.4 Group Compare quality
- **Symptom:** Group compare seems off and lacks depth.
- **Fix required:**
  - Verify group scope includes all signals for that chat (including channels).
  - Add comparisons for:
    - Avg ATH multiple
    - Avg entry MC
    - Avg time-to-X
    - Rug rate
    - Consistency (std dev)

---

## 4) Distributions & Time-of-Day View

### 4.1 Time-of-day UI readability
- **Symptom:** Current layout is dense and hard to scan.
- **Fix required:**
  - Use a compact summary block for best hours + a clean table.
  - Add row spacing and use consistent padding.

### 4.2 Volume distribution empty
- **Symptom:** Volume buckets show 0 across the board.
- **Root cause:** Provider volume data not always captured.
- **Fix required:**
  - Ensure sampling captures volume (if provider returns it).
  - If volume data is missing, show “data not available” and avoid misleading zeros.

### 4.3 Token age is empty
- **Symptom:** Token age preference shows “data not available”.
- **Root cause:** Token creation timestamps not being stored consistently.
- **Fix required:**
  - Store `createdAt` or `firstPoolCreatedAt` from Jupiter search into token metadata or signal metadata.
  - Backfill token age for recent calls when metadata exists.

---

## 5) Strategy Builder

### 5.1 Inputs not persisting
- **Symptom:** Values set in Strategy flow disappear.
- **Fix required:**
  - Ensure `pendingInput` handler does not parse everything as timeframe.
  - Confirm values persist in `strategyDraft` and update summary.
  - Add confirmation message “Saved ✅”.

### 5.2 Backtest must use the same signals as routing
- **Requirement:**
  - Backtest scope must match routing scope (same groups + forwarded signals).
  - Time windows and day-group mappings must apply.
  - TP/SL and rule priorities must be included.

### 5.3 Auto Strategy Builder
- **Requirement:**
  - Provide a “Generate Strategy” function:
    - **Max Win Rate** (conservative)
    - **Balanced**
    - **High Return** (aggressive)
  - Use analytics to choose:
    - target groups
    - min/max entry MC
    - active days/hours
    - TP/SL and rule set
  - Provide editable presets after generation.

---

## 6) Provider Issues (Critical)

### 6.1 Bitquery 401 Unauthorized
- **Symptom:** `Error fetching Bitquery OHLCV... status code 401`
- **Impact:** Historical metrics job fails → missing time-to-X + ATH accuracy.
- **Fix required:**
  - Ensure `BIT_QUERY_API_KEY` is valid and loaded in runtime env.
  - Confirm correct endpoint (`https://streaming.bitquery.io/eap`).
  - If not available, rely on GeckoTerminal or Jupiter for OHLCV.

### 6.2 Jupiter Search not used consistently
- **Symptom:** Missing audit/social/team/CTO flags in UI.
- **Fix required:**
  - In Live Signals, always attempt Jupiter search for metadata.
  - Store `audit` and `socialLinks` in the signal metadata or cache.

---

## 7) Required Actions (Implementation Plan)

### 7.1 Data Fixes (Core)
- Backfill entry MC for signals missing it.
- Backfill ATH MC + time-to-X using historical OHLCV.
- Ensure sampling runs for ENTRY_PENDING and uses meta supply.

### 7.2 Add manual "Refresh Metrics" job
- Provide a button to force:
  - historical backfill for recent signals
  - re-sampling for stale data

### 7.3 UI fixes
- Add Back + Hide buttons to all analytics panels.
- Show MC multiple next to MC delta in Live Signals.
- Make time-of-day view more readable.

### 7.4 Strategy Improvements
- Confirm all setters persist values.
- Backtest uses the same filtered signals as routing.
- Auto strategy generator based on analytics.

---

## 8) Validation Checklist (After Fixes)

1. Live Signals shows entry MC, current MC, and multiple.
2. 2x/5x/Gainers filters return correct results.
3. Recent Calls shows time-to-2x/5x/10x for high-performing calls.
4. Group Analytics shows avg entry MC, avg ATH MC, avg time-to-X.
5. Distributions show volume where available and token age once metadata is stored.
6. Strategy inputs persist and backtests respect routing conditions.
7. Bitquery or fallback provider provides OHLCV without 401 errors.

