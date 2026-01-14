# Comprehensive Serfu Redesign & Feature Overhaul Plan

This document serves as the master blueprint for elevating Serfu to a professional, high-end analytics bot. It addresses all user feedback regarding visual design ("sleekness"), data discrepancies, and feature depth.

---

## 1. Global Visual Design Language ("The Serfu Standard")
**Goal:** Replace "text dumps" with structured, dashboard-like visualizations.

### Style Guide
*   **Typography:**
    *   **Headers:** Uppercase Bold with Icon (e.g., `📊 **ANALYTICS**`).
    *   **Values:** Monospace for numbers (e.g., `+120%`, `$0.0023`).
    *   **Labels:** Regular text.
*   **Structure:**
    *   **Separators:** Use `━━━━━━━━━━━━━━━━` (Full width) and `──────────────` (Section divider).
    *   **Hierarchy:** Key data at the top, details collapsed or below.
*   **Indicators:**
    *   **Bars:** `████░░░░░░` for visual percentages.
    *   **Status:** 🟢 (Active/Profit), 🔴 (Loss/Dead), 💎 (Gem/ATH), 🎯 (Target Hit).

---

## 2. Feature-Specific Redesigns

### A. Live Signals (The "Pro Dashboard")
**User Request:** Aggregated view, filters (>2x, >5x), "Sleek" look, Token Details (Dex, Socials).
**Current State:** Cluttered list.
**New Visual Mock:**
```text
🟢 LIVE DASHBOARD (Active)
━━━━━━━━━━━━━━━━━━━━━━━━━━
1. ACORN (Acorn) 
   💎 3.5x | 💰 $120k | 🕓 5m ago
   👤 @AlphaCaller + 4 mentions
   🍬 Dex: ✅ | 👥 Team: ✅
   📉 PnL: +120% 
   ────────────────────────
2. MEEP (MEEP)
   💎 1.1x | 💰 $45k  | 🕓 12m ago
   👤 Channel: Mooners
   🍬 Dex: ❌ | 👥 Team: ❌
   📉 PnL: -12%
━━━━━━━━━━━━━━━━━━━━━━━━━━
[ 🔎 >2x Only ] [ 💎 >5x Only ]
[ 🟢 Gainers ] [ 🔴 Losers ]
```
**Functional Upgrades:**
1.  **Strict Aggregation:** Group by `mint`. Show "Earliest Caller" and "Total Group Mentions".
2.  **Smart Filters:** Users can click buttons to toggle filters (e.g., only show >2x calls).
3.  **Enriched Data:** Fetch Dex Paid / Socials status via Helius/Solana API.

### B. Recent Calls (The "Clean Timeline")
**User Request:** "Professional format," deduplicate same group reposting same token.
**Current State:** Spammy, repeating calls.
**New Visual Mock:**
```text
📜 RECENT ACTIVITY
━━━━━━━━━━━━━━━━
14:05 | 🟢 ACORN
        via 📢 Alpha Caller
        Entry: $0.0012 ➔ $0.0035
        (3.5x ATH)

13:50 | 🔴 RUGGY
        via 👤 @DegenDave
        Entry: $0.0010 ➔ $0.0001
        (Ruggable)
```
**Functional Upgrades:**
1.  **Deduplication:** If `Group A` calls `Token X` at 12:00 and again at 12:05, HIDE the 12:05 call in this view (or merge it).
2.  **Context:** Show Entry Price vs Current Price immediately.

### C. Leaderboards (The "Rankings")
**User Request:** Flexible timeframes (XH, XD), clickable stats, "Sleek" rows.
**New Visual Mock:**
```text
🏆 TOP CALLERS (Last 7 Days)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🥇 @Milaxionaire
   🎯 Score: 98
   💎 Max: 34x | Avg: 3.2x
   ✅ Win Rate: 65%
   [ 📊 View Stats ]

🥈 Alpha Caller (Channel)
   🎯 Score: 85
   💎 Max: 12x | Avg: 1.8x
   ✅ Win Rate: 40%
   [ 📊 View Stats ]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[ 1H ] [ 6H ] [ 24H ] [ 7D ] [ 30D ]
```
**Functional Upgrades:**
1.  **Dynamic Timeframes:** Support parsing `1H`, `6H`, etc.
2.  **Entity Linking:** Buttons must link to `/userstats <id>` or `/groupstats <id>`.

### D. Group/User Stats (The "Deep Analysis")
**User Request:** Fix Channel/User disconnect, fix data discrepancies, add 7+ metrics.
**Current Issue:** Channels missing from User stats; Data mismatch (34x vs 3x).
**New Visual Mock:**
```text
📊 ANALYTICS: @Milaxionaire
━━━━━━━━━━━━━━━━━━━━━━━━━━
🔹 PERFORMANCE
   Signal Count:  142
   Win Rate (>2x): 45%  ████░░░░░░
   Win Rate (>5x): 12%  █░░░░░░░░░
   Avg ROI:       +180%

🔹 RISK PROFILE
   Consistency:   High (Low StdDev)
   Avg Drawdown:  -15%
   Rug Rate:      2% (Safe)

🔹 BEHAVIOR
   Favorite MCap: < $20k
   Avg Hold Time: 45 mins
   Sniper Score:  92/100 (Very Fast)

🔹 BEST CALL
   Token: $DIH
   Peak:  34.37x
━━━━━━━━━━━━━━━━━━━━━━━━━━
[ 🏆 Top Calls ] [ 🪄 Strategy ]
```
**The "7 New Metrics":**
1.  **Consistency Score (StdDev):** Are they steady or gambling?
2.  **Rug Rate:** % of calls that go to 0.
3.  **MCap Preference:** Do they call Micros (<10k) or Mids (50k+)?
4.  **Avg Hold Time:** Time from Call to ATH.
5.  **Sniper Score:** How close are they to the deploy block?
6.  **Re-call Win Rate:** Performance on 2nd/3rd mentions.
7.  **Follow-through:** % of calls holding >2x for >1h.

### E. Distributions (The "Strategy Map")
**User Request:** Breakdown by groups, users, and market caps.
**New Visual Mock:**
```text
📈 MARKET CAP DISTRIBUTION
━━━━━━━━━━━━━━━━━━━━━━━━
MCap Range   | Win Rate | Avg X
─────────────┼──────────┼──────
< $10k       | 🟢 60%   | 4.2x
$10k - $50k  | 🟡 30%   | 1.8x
> $100k      | 🔴 5%    | 0.9x

💡 INSIGHT:
This source excels at micro-caps (<10k). 
Avoid calls >100k.
```

### F. Cross-Group Confirmations (The "Cluster Map")
**User Request:** "Which groups call things similarly and at similar times?"
**New Feature:**
*   **Pair Correlation:** "Alpha Caller & Beta Snipers match 85% of the time."
*   **Lag Analysis:** "Alpha Caller is usually 5m faster than Beta."

---

## 3. Immediate Implementation Plan

### Phase 1: Visuals & Core Fixes (Current Focus)
1.  **UIHelper Upgrade:** Implement the styles defined above (`src/utils/ui.ts`).
2.  **Recent Calls Redesign:** Apply the new timeline format and deduplication logic.
3.  **Fix Channel Stats:**
    *   Treat Channels as valid "Callers" in User Stats logic.
    *   Debug the "34x vs 3x" discrepancy (Verify Group ID aggregation).

### Phase 2: Live Signals & Filters
1.  **Aggregation Logic:** Ensure `handleLiveSignals` groups by mint strictly.
2.  **Filter Logic:** Implement the callback handlers for `>2x`, `Gainers`, etc.

### Phase 3: Advanced Analytics (The 7 Metrics)
1.  **Schema Update:** We might need to store `marketCap` and `liquidity` snapshots.
2.  **Aggregator Update:** Calculate Volatility, Rug Rate, etc.
3.  **Strategy Engine:** Build the "Auto-Strategy" recommender.

### Phase 4: Leaderboard Flex
1.  **Timeframe Parsing:** Allow custom hour/day inputs.
2.  **Drill-down:** Connect all buttons.

---

## 4. Specific Fixes for "Broken" Items
*   **"Channel calls not getting processed correct for stats"**:
    *   **Fix:** In `aggregator.ts`, explicitly handle `userId IS NULL` by grouping by `groupId` (or `chatId`) and treating it as a "Channel Entity".
*   **"Channel doesn't have user id"**:
    *   **Fix:** When clicking "User Stats" for a channel, route to `handleGroupStats` instead, OR unify the view into `handleEntityStats` that takes `type: 'USER' | 'GROUP'`.
*   **"Alpha Caller 34x vs 3x Discrepancy"**:
    *   **Fix:** Confirmed caused by `getGroupStats` looking at a single `id` while `Leaderboard` looked at `chatId`. **Fixed in code**, needs verification.

