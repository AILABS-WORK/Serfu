# Analytics & Feature Finalization Plan

This document outlines the exhaustive list of features, their current status, and the precise steps required to achieve full functionality and integration.

## 1. Core Feature: Recent Calls
**Status:** Partially Fixed. Display logic updated to show Channel Names.
**Missing/Bug:** Channel signals may still be missing from the list if the query filters them out or if they are "zombie" signals from before the fix.
**Goal:** Ensure **ALL** signals (User & Channel) appear in "Recent Calls" with correct attribution and live metrics.

### Action Plan:
1.  **Verify Query Scope:** `handleRecentCalls` queries `group: { owner: { userId: ownerTelegramId } }`.
    *   *Issue:* If a channel was added *before* the "auto-register" fix, it might be owned by a "zombie" user (ID = negative chat ID). These signals are invisible to the real user.
    *   *Fix:* Running `/addchannel` now claims the group. **However**, old signals linked to the "zombie group ID" won't move to the "new user-owned group ID" automatically.
    *   *Solution:* We must either migrate old signals or accept they are lost to history. Going forward, new signals will work.
    *   *Verification:* Post a **NEW** signal in a channel now that the fix is live. It *must* appear.
2.  **Display Logic:**
    *   *Requirement:* If `signal.userId` is null, display `signal.group.name`.
    *   *Status:* **Completed** in `handleRecentCalls`.
3.  **Metrics:**
    *   *Requirement:* Live Price, ATH, Drawdown.
    *   *Status:* **Completed** (using `updateHistoricalMetrics` + live Quote).

## 2. Core Feature: Leaderboards
**Status:** Implemented but potentially incomplete for Channels.
**Goal:** Ensure Channels appear in "Group Leaderboards" and Users in "User Leaderboards". Add "Top Tokens" leaderboard.

### Action Plan:
1.  **🏆 Top Signals (New):**
    *   *Function:* Show best performing signals (highest ATH multiple) in the workspace.
    *   *Logic:* Query `Signal` joined with `SignalMetric`, sort by `athMultiple`.
    *   *UI:* List Top 10 tokens with their ATH and Source.
2.  **Group Leaderboard (`/groupleaderboard`):**
    *   *Logic:* Aggregates by `groupId`.
    *   *Requirement:* Ensure channels (which are groups) are included.
    *   *Verification:* Check if `getGroupStats` allows channel-type groups. (It does, `Group` model has `chatType`).
3.  **User Leaderboard (`/userleaderboard`):**
    *   *Logic:* Aggregates by `userId`.
    *   *Issue:* Channel signals have `userId: null`. They are excluded from User Leaderboards.
    *   *Decision:* This is correct. Channels are not Users. They should dominate the Group Leaderboard.
4.  **UI Integration:**
    *   *Task:* Wire up `leaderboard_menu` buttons to call the existing commands via callback. Add "Top Signals" button.

## 3. Core Feature: Group Stats (Destination View)
**Goal:** Running `/groupstats` or viewing analytics in the Destination Group should show a "Collage" of all signals sent there.

### Action Plan:
1.  **Aggregated Stats:**
    *   *Logic:* If target is a "Destination Group", fetch stats for ALL signals that were *forwarded* to it (or owned by the destination owner).
    *   *Implementation:* Modify `getGroupStats` to handle "Destination Mode": aggregate signals from all source groups owned by the user.
2.  **Deep Dive Analysis (Buckets):**
    *   *Function:* "Tokens under 20k do better...".
    *   *Implementation:* In `GroupStats`, calculate performance buckets:
        *   Entry MC < 20k
        *   20k - 50k
        *   50k - 100k
        *   > 100k
    *   *UI:* Show Win Rate & Avg ROI for each bucket.

## 4. Core Feature: Analytics Menu & Buttons
**Status:** Many buttons are placeholders.
**Goal:** Every button on the dashboard must do something useful.

### Action Plan:
1.  **🟢 Live Signals:**
    *   *Function:* Show list of active signals (e.g., < 24h old, not stopped out).
    *   *Implementation:* New handler `handleLiveSignals`. Query `trackingStatus: 'ACTIVE'`.
    *   *UI:* Compact list with current PnL.
2.  **📊 Distributions:**
    *   *Function:* Show win-rate distribution (e.g., Histogram of multipliers).
    *   *Implementation:* New handler `handleDistributions`. Aggregate `athMultiple` buckets.
    *   *UI:* Text-based bar chart.
3.  **⭐ Watchlist:**
    *   *Function:* Save favorite signals.
    *   *Implementation:*
        *   Schema: Add `Watchlist` model (`userId`, `signalId`).
        *   UI: Add "Add to Watchlist" button on signal cards.
        *   View: Show saved signals list.
4.  **👥 My Groups:**
    *   *Status:* Works (`/groups`).
    *   *Improvement:* Add inline buttons to each group in the list to "View Stats" directly.
5.  **👤 User Stats:**
    *   *Status:* Works (`/userstats`).
    *   *Improvement:* If clicked without args, show *my* stats.

## 5. Core Feature: Signal Cards
**Status:** Good, but "Unknown User" fix needs verification.
**Goal:** Perfect presentation.

### Action Plan:
1.  **Channel Attribution:**
    *   *Status:* **Fixed** in `generateFirstSignalCard` and `generateDuplicateSignalCard`.
2.  **Whale Alerts:**
    *   *Status:* Implemented.
    *   *Verification:* Ensure it triggers on real data.

## 6. System: Metrics Calculation
**Status:** Robust (Bitquery + GeckoTerminal + Helius).
**Goal:** Accuracy and Speed.

### Action Plan:
1.  **ATH Accuracy:**
    *   *Logic:* `updateHistoricalMetrics` uses OHLCV.
    *   *Edge Case:* If a token pumps 100x in 1 minute, 1-minute candles might miss the wick? (Unlikely, High is captured).
    *   *Status:* Acceptable.
2.  **Performance:**
    *   *Task:* Add database indexes on `Signal(detectedAt, groupId)`, `Signal(userId, detectedAt)`.

## 7. Full Integration Checklist (The "Definition of Done")

- [ ] **Recent Calls:** Shows User signals AND Channel signals (with Channel Name).
- [ ] **Leaderboards:**
    - [ ] Top Groups shows Channels.
    - [ ] Top Users shows individual callers.
    - [ ] Top Signals (New) shows best tokens.
- [ ] **My Groups:** Lists all sources, allows management.
- [ ] **User Stats:** Shows stats for queried user OR self.
- [ ] **Group Stats (Advanced):** Shows Aggregated Stats for Destination + MC Buckets.
- [ ] **Live Signals:** Shows active plays.
- [ ] **Distributions:** Shows win rate histogram.
- [ ] **Watchlist:** Can add/remove and view signals.
- [ ] **Earliest Callers:** Correctly attributes "First" status across the workspace.
- [ ] **Cross-Group Confirms:** Correctly identifies overlap.
- [ ] **Copy Trading:** Simulation works.

## 8. Immediate Next Steps (Code)

1.  **Wire up `leaderboard_menu`** to show "Top Groups", "Top Users", and "Top Signals".
2.  **Implement `handleLiveSignals`**.
3.  **Implement `handleDistributions`** (with MC Buckets analysis).
4.  **Update `getGroupStats`** to include "Destination Aggregation" and "Bucket Analysis".
5.  **Implement `Watchlist`** (Schema + Logic).
