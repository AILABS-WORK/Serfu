# Analytics & Statistics Implementation Plan

## 1. Objective
To provide comprehensive, data-driven insights into the performance of **Source Groups** and **Individual Users**. The system will track every signal's lifecycle to calculate key performance indicators (KPIs) such as ATH Multiples, Win Rates, and Drawdowns. This data will be accessible via on-demand reports and leaderboards.

## 2. Core Metrics
We will track and calculate the following for each entity (Group/User):

### Per-Signal Metrics (Stored in `SignalMetric`)
*   **Entry Price / MC**: Captured at signal creation.
*   **ATH Price / MC**: The highest price point reached since the signal.
*   **ATH Multiple**: `ATH Price / Entry Price` (e.g., 5.4x).
*   **Max Drawdown**: The lowest price point relative to entry (e.g., -40%).
*   **Time to ATH**: Duration from signal creation to ATH peak.

### Aggregate Metrics (Calculated On-Demand)
*   **Total Signals**: Count of valid signals tracked.
*   **Win Rate**: % of signals that hit specific targets (e.g., >2x, >5x).
*   **Average Peak Multiplier**: The average "best case" scenario for their calls.
*   **Best Call**: The single highest performing signal (Token + Multiple).
*   **Reliability Score**: A composite score based on consistency and volume.

## 3. Database Strategy

### Existing Schema Status
*   `Signal`: Stores `entryPrice`, `entryMarketCap`.
*   `SignalMetric`: Stores `athPrice`, `athMultiple`, `maxDrawdown`, `currentPrice`.
*   *Action Item*: Ensure `priceAlerts` job updates these fields frequently enough for accuracy.

### On-Demand Calculation
Instead of pre-calculating everything, we will use efficient Prisma aggregations when a user requests stats.
*   **Why**: Keeps data fresh and reduces database write load.
*   **How**: When `/group_stats` is called:
    1.  Fetch last N signals for the group.
    2.  Calculate Avg ATH, Win Rate, etc., in memory or via DB aggregation.
    3.  Generate the report.

## 4. User Interface & Commands

### A. Analytics Dashboard (`/analytics`)
Update the existing menu to be the central hub.
*   **Buttons**:
    *   `🏆 Leaderboards`: Top Groups / Top Users.
    *   `👥 Groups`: List tracked groups with high-level stats (e.g., "Avg 3.5x").
    *   `👤 Users`: List top callers.
    *   `📜 Recent Calls`: (Implemented) Quick view of last 6 signals.
    *   `📉 Worst Performers`: (New) Educational view of "Rekt" calls.

### B. Detailed Stats View (`/group_stats <id>` & `/user_stats <id>`)
When clicking a group/user from a list or leaderboard:
*   **Header**: Name, Total Calls, "Grade" (S/A/B/C/D based on ROI).
*   **Performance Matrix**:
    *   `Avg ROI`: 3.2x
    *   `Max ROI`: 45x ($PEPE)
    *   `Win Rate (>2x)`: 68%
*   **Chart**: (Optional) ASCII or generated image trendline of their performance.
*   **Recent Signals List**:
    *   `$TOKEN`: +450% (ATH)
    *   `$COIN`: -20% (Rekt)

### C. Leaderboards
*   **Sort Options**:
    *   `By PnL`: Highest Average ATH Multiple.
    *   `By Frequency`: Most active callers.
    *   `By Consistency`: Best Win Rate (>2x).
*   **Timeframes**: 7D, 30D, All Time.

## 5. Technical Implementation Steps

### Phase 1: Data Integrity (The Foundation)
1.  **Refine Tracking Job**: Ensure `src/jobs/priceAlerts.ts` correctly updates `SignalMetric.athMultiple` for *all* active signals, not just those hitting alerts.
2.  **Backfill**: Script to check past signals and update their ATHs using Jupiter API (if possible/historical).

### Phase 2: Aggregation Logic
1.  Create `src/analytics/aggregator.ts`.
2.  Implement `getGroupStats(groupId, timeframe)`: Returns the aggregate object.
3.  Implement `getUserStats(userId, timeframe)`: Returns the aggregate object.

### Phase 3: UI Implementation
1.  **Leaderboard UI**: Create a clean, text-based leaderboard message (Telegram doesn't support tables well, so use formatted text).
    *   Example: `1. 🥇 @WhaleCaller | 💎 14.5x Avg | 🎯 82% WR`
2.  **Stats Card UI**: A detailed "Profile" card for groups/users.
3.  **Interaction**: Wire up the "Sort By" callbacks in `src/bot/actions.ts`.

## 6. Detailed Data Requirements

We need to ensure we have:
*   `Signal.createdAt` (Already exists).
*   `Signal.entryPrice` (Crucial - must be non-null).
*   `SignalMetric.athPrice` (Must be updated continuously).

## 7. Next Steps
1.  **Approve this plan.**
2.  **Execute Phase 1**: Strengthen the ATH tracking job.
3.  **Execute Phase 2 & 3**: Build the aggregators and UI.













