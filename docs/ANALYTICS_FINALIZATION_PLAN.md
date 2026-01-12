# Analytics & Leaderboard Finalization Plan

This document outlines the steps to finalize the bot's analytics features, ensuring all dashboard buttons are functional, metrics are accurate, and channel signals are correctly attributed.

## 1. Core Issues to Fix Immediately

### A. Recent Calls & Channel Signals
- **Problem**: Signals from channels are not appearing in "Recent Calls", or appear with "Unknown User".
- **Root Cause**: 
    1. Channel posts (anonymous) often have no `userId` attached to the signal.
    2. Display logic expects a `user` relation and defaults to "Unknown".
    3. Query might be accidentally filtering out signals without users if not careful (though current Prisma query looks okay, the display is the issue).
- **Fix**: 
    - Update `handleRecentCalls` to check if `signal.user` exists.
    - If no user, use `signal.group.name` (Channel Name) as the "Caller".
    - Ensure the database query includes signals from owned groups even if `userId` is null.

### B. "Unknown User" in Signal Cards
- **Problem**: Forwarded cards for channel posts show "Alpha caller • @Unknown User".
- **Fix**: 
    - Update `generateFirstSignalCard` and `generateDuplicateSignalCard`.
    - If `userName` is "Unknown User" or missing, and it's a channel source, display the **Channel Name** instead.

## 2. Feature Implementation Status & Tasks

### 🏆 Leaderboards
- **Current Status**: Commands exist (`/groupleaderboard`, `/userleaderboard`), but need verifying against "Menu" buttons.
- **Tasks**:
    - Ensure "🏆 Leaderboards" menu button routes to a sub-menu asking "Groups" or "Users".
    - Wire up `leaderboard_groups` and `leaderboard_users` callbacks.
    - Verify scoring logic (Consistency vs Total Wins).

### 👥 My Groups
- **Current Status**: `/groups` command works.
- **Tasks**:
    - Ensure "👥 My Groups" button triggers the existing `handleGroupsCommand` logic.
    - Add "Stats" button next to each group in the list to jump to `/groupstats`.

### 📜 Recent Calls
- **Current Status**: Implemented but buggy for channels.
- **Tasks**:
    - Apply Fix A (above).
    - Ensure "ATH" and "Cur" metrics are live (already using `metrics` table).

### 👤 User Stats
- **Current Status**: `/userstats` works.
- **Tasks**:
    - Ensure "👤 User Stats" button prompts for a user or shows the *current* user's stats if they have any.
    - Add a "My Stats" fallback if no ID is provided.

### 🚀 Earliest Callers
- **Current Status**: Implemented (`handleEarliestCallers`).
- **Tasks**:
    - Verify it correctly counts "First Caller" events across the entire database or workspace.
    - Ensure it filters by the user's monitored scope (optional, but requested "your workspace").

### 🔄 Cross-Group Confirms
- **Current Status**: Implemented (`handleCrossGroupConfirms`).
- **Tasks**:
    - Verify it correctly identifies same-mint signals across different groups.

### 📊 Distributions
- **Current Status**: Placeholder.
- **Tasks**:
    - Implement a simple "Win Rate Distribution" text visualization.
    - Example: "2x: 40% | 5x: 10% | 10x: 2%".

### 🟢 Live Signals
- **Current Status**: Placeholder.
- **Tasks**:
    - Implement logic to fetch signals with `trackingStatus: 'ACTIVE'`.
    - Show a compact list of currently active plays with their current PnL.

### ⭐ Watchlist
- **Current Status**: Placeholder.
- **Tasks**:
    - Add "⭐ Add to Watchlist" button on Signal Cards.
    - Implement `handleWatchlist` to show saved signals.
    - Create `Watchlist` table in Prisma (User <-> Signal many-to-many).

## 3. Metrics & Performance Optimization

### Speed Improvements
- **Action**: Ensure `price_samples`, `signals`, and `groups` tables have proper indices on `chatId`, `userId`, `mint`, and `detectedAt`.
- **Action**: Optimize `updateHistoricalMetrics` to batch updates more aggressively if needed.

### Data Accuracy
- **Action**: Review `historicalMetrics.ts` to ensure it uses the *earliest* detection time for ATH calculation relative to *that specific signal*.
- **Action**: Ensure Channel signals (with no user) are still counted in "Group Metrics".

## 4. Execution Plan

1.  **Phase 1: Critical Fixes (Done Today)**
    - Fix Channel display in Recent Calls & Cards.
    - Wire up all Main Menu buttons to their respective handlers.

2.  **Phase 2: Missing Features (Next)**
    - Implement "Live Signals" view.
    - Implement "Distributions" view.
    - Implement "Watchlist" (Schema change required).

3.  **Phase 3: Validation**
    - Run the "Full Scan" verification script to ensure all buttons return valid data.

