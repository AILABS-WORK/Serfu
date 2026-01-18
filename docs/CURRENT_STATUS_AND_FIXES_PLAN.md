# CURRENT STATUS AND FIXES PLAN
**Created:** 2025-01-27  
**Based on:** Comprehensive bot walkthrough and functionality audit

---

## EXECUTIVE SUMMARY

This document details the current state of the Serfu bot, identifies all broken features, and provides a detailed fix plan for each issue. The audit was conducted through a complete walkthrough of all bot features.

---

## 1. FUNCTIONALITY STATUS BY FEATURE

### ✅ WORKING FEATURES

1. **Recent Calls**
   - Status: ✅ Working correctly
   - Notes: User confirmed this feature is functioning as expected

2. **Groups - Monitored Groups**
   - Status: ✅ Working (channels appearing correctly)
   - Notes: Signals are being marked and displayed properly

---

### ❌ BROKEN FEATURES

#### 1.1 Live Signals
**Status:** ❌ COMPLETELY BROKEN - Timeout after 20 seconds

**Symptoms:**
- Shows "Loading live data..." but never finishes
- Eventually times out without loading any data
- Clicking Live Signals does nothing

**Root Cause Analysis:**
- The `handleLiveSignals` function performs expensive database queries:
  - Line 993-1000: `prisma.priceSample.findMany()` query for last 10 minutes of samples for ALL signals
  - Line 1087-1103: Parallel `provider.getTokenMeta()` calls for top 10 (but all metadata is fetched)
  - The query at 993-1000 is particularly problematic as it queries ALL signals without pagination

**Fix Required:**
1. Remove or optimize the expensive `priceSample.findMany()` query (lines 993-1000)
2. Cache or pre-compute trending velocity instead of calculating on-demand
3. Add query timeouts and better error handling
4. Consider pagination for large signal sets
5. Move velocity calculation to background jobs

**Priority:** 🔴 CRITICAL (Blocks core feature)

---

#### 1.2 Leaderboards - Top Groups
**Status:** ⚠️ PARTIALLY BROKEN - Incorrect calculations

**Symptoms:**
- Shows stats like "277 signals, 41 above 2x, 11 above 5x"
- User questions if time to 2x/5x/10x are calculated correctly (e.g., "2.5 hours, 9.3 and 18 minutes")
- Average entry 1.19M, average ATH 1.55M - user unsure if correct
- Best call shown as "DIH" but user thinks there were better ones
- Statistics not being pulled correctly from channels/groups

**Root Cause Analysis:**
- `getGroupStats` in `src/analytics/aggregator.ts` uses `thresholdEvents` to count hits above 2x/5x/10x
- If `thresholdEvents` are not being created properly, hit rates will be wrong
- Time to ATH calculation may use `metrics.timeTo2x` fields which might not be populated correctly
- Best call selection might not be using `athMultiple` correctly

**Fix Required:**
1. Audit `thresholdEvents` creation in `src/analytics/metrics.ts` - ensure they're being created at correct thresholds
2. Verify time-to-X calculations - ensure `timeTo2x`, `timeTo5x`, `timeTo10x` are being populated in `SignalMetric`
3. Fix best call selection to use `athMultiple` correctly (currently might be using `currentMultiple`)
4. Ensure group statistics include signals from channels (userId=null cases)
5. Verify average entry/ATH MC calculations use real signal data, not mocked values

**Priority:** 🟡 HIGH (Core analytics feature)

---

#### 1.3 Leaderboards - Top Signals
**Status:** ❌ BROKEN - Missing data and incorrect calculations

**Symptoms:**
- No entry market cap shown
- Time to ATH showing negative values (e.g., "-1 minute")
- Incorrect time calculations

**Root Cause Analysis:**
- `getSignalLeaderboard` in `src/analytics/aggregator.ts` (lines 538-605) calculates `timeToAth` incorrectly
- Entry market cap might not be loaded in the query includes
- Negative time values suggest `athAt` < `detectedAt`, which shouldn't happen

**Fix Required:**
1. Ensure `entryMarketCap` is included in signal query (add to include clause if missing)
2. Fix `timeToAth` calculation - add validation to ensure `athAt >= detectedAt`
3. If `timeToAth` in `metrics` is stored in milliseconds, convert correctly (line 583)
4. Add fallback if `timeToAth` is null/undefined
5. Verify `athAt` timestamps are being set correctly in `updateSignalMetrics`

**Priority:** 🟡 HIGH (Core analytics feature)

---

#### 1.4 Distributions
**Status:** ⚠️ PARTIALLY BROKEN - Data discrepancy

**Symptoms:**
- Shows "211 signals" but "678 calls" in distributions
- User confused about discrepancy
- User wants everything routed from real signals, not sampled/faked/mocked

**Root Cause Analysis:**
- `getDistributionStats` in `src/analytics/aggregator.ts` (lines 678-1118) might be double-counting signals
- Forwarded signals might be included separately, causing inflated counts
- The `scopeFilter` OR logic (lines 707-712) might be including both source and forwarded signals

**Fix Required:**
1. Audit the signal counting logic in `getDistributionStats` - ensure no double-counting
2. Clarify "signals" vs "calls" terminology:
   - **Signal** = One unique token mint detected
   - **Call** = One mention/post of that token (can have multiple calls per signal)
3. If distributions should show "calls" (mentions), count `signals.length` correctly
4. If distributions should show "signals" (unique tokens), deduplicate by `mint`
5. Ensure all data comes from real `Signal` records, not mocked/sampled data
6. Verify `forwardedSignalIds` logic isn't double-counting

**Priority:** 🟡 HIGH (Analytics accuracy critical)

---

#### 1.5 Strategy Creation / Auto Strategy
**Status:** ❌ BROKEN - Not working correctly

**Symptoms:**
- Strategy created from "auto strategy" looks terrible/unrealistic
- Not actually analyzing signals and analytics to create strategy
- Simulate/backtest not working
- Needs more examples and better functionality

**Root Cause Analysis:**
- Strategy generation likely not implemented or using placeholder logic
- Backtesting not implemented
- No actual analytics-based strategy recommendation

**Fix Required:**
1. Implement real strategy generation that analyzes:
   - Group/user win rates from distributions
   - Time-of-day patterns from distributions
   - MC bucket performance
   - Volume/liquidity correlations
2. Implement backtesting engine that simulates strategy over historical data
3. Add examples and documentation for strategy usage
4. Connect strategy to real analytics data (not mocked)

**Priority:** 🟠 MEDIUM (Feature enhancement, not blocking core)

---

#### 1.6 Duplicate Signal Detection
**Status:** ❌ BROKEN - Shows "new signal" incorrectly

**Symptoms:**
- When a CA appears in a group for the first time, it says "new signal detected"
- But if that same CA was already detected in another group before, it should NOT say "new signal"
- Should only say "new signal" if it's the FIRST time that CA appears anywhere in the workspace

**Root Cause Analysis:**
- `checkDuplicateCA` in `src/bot/signalCard.ts` (lines 27-66) only checks within the same `groupId` or `ownerId`
- It doesn't check globally across all groups in the workspace
- `generateFirstSignalCard` vs `generateDuplicateSignalCard` decision is made too narrowly

**Fix Required:**
1. Modify `checkDuplicateCA` to check globally across all groups owned by the same user (workspace-wide check)
2. When `ownerId` is provided, check if ANY signal with that mint exists in ANY group owned by that user
3. Only show "NEW SIGNAL DETECTED" if it's truly the first time that mint appears in the entire workspace
4. Otherwise, show "MENTIONED AGAIN" even if it's the first time in that specific group

**Priority:** 🟡 HIGH (UX confusion)

---

#### 1.7 Signal Routing / Count Discrepancy
**Status:** ⚠️ PARTIALLY BROKEN - Counts don't match

**Symptoms:**
- Groups page shows "7,000 signals" but user thinks they only had 217 calls
- Not sure if routing is correct

**Root Cause Analysis:**
- Group signal counts might be counting forwarded signals, or double-counting
- The query might be including signals from all time (not filtered by timeframe)
- Forwarded signals might be counted separately from source signals

**Fix Required:**
1. Audit signal counting in groups view - ensure it's using correct filters (timeframe, active only, etc.)
2. Clarify whether group counts should show:
   - Total signals detected in that group (source signals)
   - OR total signals forwarded to that group (destination signals)
   - OR both separately
3. Add timeframe filters to group signal counts if missing
4. Ensure no double-counting between source and destination groups

**Priority:** 🟡 HIGH (Data accuracy)

---

## 2. DETAILED FIX PLAN BY ISSUE

### FIX 1: Live Signals Timeout
**File:** `src/bot/commands/analytics.ts`  
**Function:** `handleLiveSignals` (lines 847-1223)

**Status:** ✅ IN PROGRESS

**Problem Found:**
- Lines 993-1000: Expensive `prisma.priceSample.findMany()` query loading ALL signals' samples from last 10 minutes
- This query causes 20+ second timeout when there are many active signals

**Solution Applied:**
1. ✅ **REMOVED expensive priceSample query** (lines 991-1011)
   - Removed the `prisma.priceSample.findMany()` call
   - Removed the `mcapHistory` Map building loop
   
2. ✅ **Simplified velocity calculation**
   - Removed 10-minute velocity calculation that depended on priceSample query
   - Using PnL as velocity proxy for trending sort (high PnL = trending up)
   - Can be enhanced later using cached metrics if needed

**Changes Made:**
- Removed lines 991-1011: priceSample query and mcapHistory building
- Modified velocity assignment to use `row.pnl` as proxy

**Additional Fix (Round 2):**
- ✅ **Removed expensive `getMultipleTokenPrices` call for all mints**
  - Was calling Jupiter API for potentially hundreds of tokens
  - Now uses cached `signal.metrics.currentMarketCap` (updated by background jobs)
  - Only fetches fresh metadata for top 10 displayed signals

**Testing Needed:**
- [ ] Test Live Signals loads without timeout (< 5 seconds expected)
- [ ] Verify trending sort still works (uses PnL now)
- [ ] Verify all other filters/sorts still work
- [ ] Test with many active signals (should not timeout)

**Estimated Time:** 2-3 hours (Completed: ~1 hour)

---

### FIX 2: Leaderboard Calculations
**File:** `src/analytics/aggregator.ts`  
**Functions:** `getGroupStats`, `getSignalLeaderboard`, `calculateStats`

**Changes Required:**

1. **Audit thresholdEvents creation:**
   - File: `src/analytics/metrics.ts`
   - Ensure `ThresholdEvent` records are created when signals hit 2x, 5x, 10x
   - Verify the logic in `updateSignalMetrics` triggers threshold events

2. **Fix time-to-X calculations:**
   - Ensure `timeTo2x`, `timeTo5x`, `timeTo10x` fields are populated in `SignalMetric`
   - Add calculation logic in `updateSignalMetrics` if missing
   - Use `thresholdEvents.hitAt` timestamps to calculate if fields not populated

3. **Fix best call selection:**
   - In `calculateStats`, ensure `bestSignal` uses `metrics.athMultiple` (line 179-182)
   - Not `currentMultiple`

4. **Fix group statistics for channels:**
   - Ensure `getGroupStats` includes signals where `userId IS NULL` (channel signals)
   - Group by `chatId` not just `groupId` if needed

5. **Fix entry/ATH MC display:**
   - Ensure `entryMarketCap` and `athMarketCap` are loaded in queries
   - Use real values from `signal.entryMarketCap` and `signal.metrics.athMarketCap`
   - Never use mocked/sampled values

**Estimated Time:** 4-5 hours

---

### FIX 3: Top Signals - Entry MC & Time to ATH
**File:** `src/analytics/aggregator.ts`  
**Function:** `getSignalLeaderboard` (lines 538-605)

**Status:** ✅ COMPLETED

**Problem Found:**
- Missing `priceSamples` in query include, so `entryMarketCap` fallback wasn't available
- `timeToAth` calculation didn't validate `athAt >= detectedAt`, causing negative times

**Solution Applied:**
1. ✅ **Added priceSamples to query include**
   - Now includes first priceSample for entryMarketCap fallback
   
2. ✅ **Fixed timeToAth calculation with validation**
   - Added check: `if (diffMs > 0)` before calculating
   - Added warning log if negative time detected (shouldn't happen)
   - Properly converts milliseconds to minutes

3. ✅ **Added entryMarketCap fallback**
   - Uses `s.entryMarketCap || s.priceSamples?.[0]?.marketCap || null`

**Changes Made:**
- Modified query include to add `priceSamples`
- Added validation to `timeToAth` calculation
- Added fallback for `entryMarketCap`

**Testing Needed:**
- [ ] Verify entry MC displays correctly in Top Signals
- [ ] Verify timeToAth shows positive values (no negative minutes)
- [ ] Test with signals that have null entryMarketCap (should use fallback)

**Estimated Time:** 1-2 hours (Completed: ~30 min)

---

### FIX 4: Distributions Data Discrepancy
**File:** `src/analytics/aggregator.ts`  
**Function:** `getDistributionStats` (lines 678-1118)

**Changes Required:**
1. **Audit signal counting:**
   - Lines 720-733: Review the `scopeFilter` OR logic
   - Ensure forwarded signals aren't double-counted
   - Clarify if we want "signals" (unique mints) or "calls" (total mentions)

2. **Fix count reporting:**
   - `stats.totalSignals` should match what's displayed
   - If showing "calls", count all signal instances
   - If showing "signals", deduplicate by `mint`

3. **Ensure real data only:**
   - Remove any mocked/sampled data
   - All stats must come from `prisma.signal.findMany` query
   - Verify `metrics` are real, not placeholder values

**Estimated Time:** 2-3 hours

---

### FIX 5: Duplicate Signal Detection
**File:** `src/bot/signalCard.ts`  
**Function:** `checkDuplicateCA` (lines 27-66)  
**Also check:** `src/bot/forwarder.ts` (line 132) and `src/ingest/processor.ts` (line 204)

**Status:** ✅ COMPLETED

**Problem Found:**
- `checkDuplicateCA` had priority: `groupId` first, then `ownerId`
- When `groupId` was provided, it only checked within that group (group-scoped)
- This meant "NEW SIGNAL" appeared even if the CA already existed in another group in the same workspace

**Solution Applied:**
1. ✅ **Changed priority to workspace-wide when ownerId provided**
   - If `ownerId` is provided, always check ALL groups owned by that user (workspace-wide)
   - `groupId` is now only used as fallback if no `ownerId` provided
   - This ensures "NEW SIGNAL" only shows if it's the FIRST time that mint appears anywhere in the workspace

**Changes Made:**
- Modified `checkDuplicateCA` to prioritize `ownerId` over `groupId`
- Added comment explaining workspace-wide behavior
- Call sites already pass `ownerId` correctly (forwarder.ts line 132, processor.ts line 204)

**Testing Needed:**
- [ ] Test: CA appears in Group A -> should show "NEW SIGNAL"
- [ ] Test: Same CA appears in Group B (same workspace) -> should show "MENTIONED AGAIN"
- [ ] Test: CA appears in different user's workspace -> should show "NEW SIGNAL" (correct)

**Estimated Time:** 1-2 hours (Completed: ~20 min)

---

### FIX 6: Strategy Creation (Future Work)
**Status:** Deferred for now, requires significant implementation

**Files:** `src/analytics/copyTrading.ts`, `src/bot/commands/copyTrading.ts`

**Future Work:**
1. Implement real strategy generation using distribution analytics
2. Implement backtesting engine
3. Add examples and documentation

**Estimated Time:** 8-12 hours (deferred)

---

### FIX 7: Signal Count Discrepancy in Groups
**File:** `src/bot/commands/groups.ts` (or wherever group stats are displayed)

**Changes Required:**
1. Audit signal counting query - ensure timeframe filters
2. Clarify source vs destination signal counts
3. Add filters if missing

**Estimated Time:** 1 hour (requires finding the exact file first)

---

## 3. TESTING PLAN

For each fix, test:
1. ✅ Feature loads without timeout
2. ✅ Data displayed is accurate (matches database)
3. ✅ Calculations are correct (no negative times, proper averages)
4. ✅ No double-counting of signals
5. ✅ Duplicate detection works workspace-wide

---

## 4. PRIORITY ORDER

1. 🔴 **CRITICAL:** Fix Live Signals timeout (FIX 1) - Blocks core feature
2. 🟡 **HIGH:** Fix Leaderboard calculations (FIX 2, FIX 3) - Core analytics
3. 🟡 **HIGH:** Fix Distributions data (FIX 4) - Analytics accuracy
4. 🟡 **HIGH:** Fix Duplicate detection (FIX 5) - UX confusion
5. 🟡 **HIGH:** Fix Signal count discrepancy (FIX 7) - Data accuracy
6. 🟠 **MEDIUM:** Strategy creation (FIX 6) - Deferred for now

---

## 5. NOTES

- All fixes must use **real signal data** from the database, never mocked/sampled data
- All calculations must use **market cap**, not price (per user requirements)
- ATH calculations should use OHLCV data (already implemented in `updateSignalMetrics`)
- Background jobs must keep `signal.metrics` up-to-date for fast UI loading

---

## 6. PROGRESS TRACKING

### ✅ COMPLETED FIXES

1. **FIX 1: Live Signals Timeout** ✅
   - Status: Fixed
   - Changes: Removed expensive priceSample query
   - Time taken: ~30 min
   - Testing: Pending

2. **FIX 3: Top Signals - Entry MC & Time to ATH** ✅
   - Status: Fixed
   - Changes: Added priceSamples to query, fixed timeToAth validation, added entryMarketCap fallback
   - Time taken: ~30 min
   - Testing: Pending

3. **FIX 5: Duplicate Signal Detection** ✅
   - Status: Fixed
   - Changes: Made workspace-wide check priority when ownerId provided
   - Time taken: ~20 min
   - Testing: Pending

### 🔄 IN PROGRESS / PENDING

4. **FIX 2: Leaderboard Calculations**
   - Status: Partially complete (bestSignal already uses athMultiple correctly)
   - Need to verify: thresholdEvents creation, time-to-X fields population
   - Priority: HIGH

5. **FIX 4: Distributions Data Discrepancy**
   - Status: Pending
   - Need to: Audit signal counting, clarify signals vs calls
   - Priority: HIGH

6. **FIX 7: Signal Count Discrepancy in Groups**
   - Status: Pending
   - Need to: Find groups.ts file, audit counting logic
   - Priority: HIGH

7. **FIX 6: Strategy Creation**
   - Status: Deferred (requires full implementation)
   - Priority: MEDIUM

### 📊 SUMMARY

- **Completed:** 3 fixes (FIX 1, FIX 3, FIX 5)
- **In Progress:** 1 fix (FIX 2 - partially done)
- **Pending:** 3 fixes (FIX 4, FIX 7, FIX 6)
- **Total Time Spent:** ~1.5 hours
- **Critical Fixes Remaining:** FIX 2, FIX 4, FIX 7

---

**END OF PLAN**

