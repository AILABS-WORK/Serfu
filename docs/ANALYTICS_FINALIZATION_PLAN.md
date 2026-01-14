# Analytics & Feature Finalization Plan

This document outlines the exhaustive list of features, their current status, and the precise steps required to achieve full functionality and integration, updated based on user testing feedback.

## 1. Visual Redesign (Global Priority)
**Status:** Needs Implementation.
**Goal:** Sleek, organized, professional. Maximize Telegram markdown capabilities.
**Elements:**
*   **Headers:** Bold, Emojis, Underlined? (Telegram doesn't support underline well in all clients, stick to Bold/Monospace).
*   **Separators:** `━━━━━━━━━━━━━━━━` or `〰️〰️〰️〰️〰️`.
*   **Data Layout:** "Key: Value" with fixed width or clear separation.
*   **Typography:** Bold for emphasis, Monospace for numbers/CA.

### Action Plan:
1.  **Create `UIHelper`:** A utility class for standardized formatting.
    *   `UIHelper.header(text)`
    *   `UIHelper.separator()`
    *   `UIHelper.field(key, value)`
    *   `UIHelper.tokenRow(symbol, pnl, mentions, caller)`
    *   `UIHelper.formatCurrency(val)`
    *   `UIHelper.formatPercent(val)`
2.  **Apply to All Views:** Refactor `analytics.ts` to use this helper for consistent "Sleek" look.

## 2. Core Feature: Live Signals (Aggregation & Filters)
**Status:** Needs Overhaul.
**New Requirement:**
*   **Aggregation:** Show **ONE** row per Token (CA).
*   **Columns:** Token | Earliest Caller | Total Group Mentions | Dex/Migrated Status | PnL.
*   **Filters:** >2x, >5x, >10x, Positive, Negative.
*   **Logic:**
    *   Fetch all active signals in workspace.
    *   Group by `mint`.
    *   Calculate: `Earliest Caller` (Oldest signal), `Mentions` (Count of signals for this mint), `PnL` (Current Price vs Earliest Entry).

### Action Plan:
1.  **Refactor `handleLiveSignals`:**
    *   Change query to fetch *all* active signals, then group by `mint` in code.
    *   Enrich with `provider.getTokenMeta` for Dex/Migration status.
    *   Calculate "Earliest Caller" and "Total Mentions" per mint.
2.  **Add Filters:**
    *   UI Buttons: `[ > 2x ]`, `[ > 5x ]`, `[ 🟢 Gainers ]`, `[ 🔴 Losers ]`.
    *   Callback `live_signals:filter:X` to reload with filters.
3.  **UI Redesign:** Use `UIHelper` for a "Card" or "Compact Table" layout.

## 3. Core Feature: Leaderboards (Timeframes & Drill-down)
**Status:** Functional, needs flexibility.
**New Requirement:**
*   **Custom Timeframes:** 1H, 5H, 12H, 1D, 1W, 1M (XH, XD, XW formats).
*   **Deep Drill-down:** Click User/Group -> See Stats -> See "Best Calls" -> See Signal Details.

### Action Plan:
1.  **Update Aggregator:**
    *   Modify `getDateFilter` to support generic `XH`, `XD`, `XW` parsing.
2.  **UI Update:**
    *   Add a "🕒 Custom" button that shows a grid of timeframe options.
3.  **Drill-down:**
    *   Ensure clicking a Leaderboard entry opens that entity's stats.
    *   Ensure Entity Stats view has a "🏆 Top Calls" button.

## 4. Core Feature: Recent Calls
**Status:** Improved.
**Refinement:**
*   Ensure "Timeline" view is clean.
*   Use `UIHelper` for consistent look.

## 5. Strategy Creator (AI/Algo)
**Status:** Pending.
**Plan:** Implement `src/analytics/strategy.ts` and UI button.

## 6. Immediate Execution Order
1.  **UI Helper:** Create `src/utils/ui.ts`.
2.  **Live Signals Overhaul:** Implement Aggregation + Filters + New Design.
3.  **Leaderboard Timeframes:** Update `aggregator` and UI.
4.  **Drill-down Navigation:** Link views.
