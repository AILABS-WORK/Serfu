# Design & Improvement Plan

This document details the comprehensive redesign and functional overhaul required to elevate the Serfu bot to a professional, "sleek" standard. It addresses specific user feedback regarding visual presentation, data accuracy, and feature depth.

## 1. Global Visual Redesign ("Sleek & Professional")

**Goal:** Move away from "just text" to a visually rich, structured layout using advanced Telegram Markdown/HTML techniques.
**Style Guide:**
*   **Header:** Bold, Uppercase, Emojis.
*   **Data Grid:** Use "Key: Value" pairs with consistent padding.
*   **Separators:** Use thin lines `──────────────` for cleaner separation than thick bars.
*   **Indicators:** Use visual bars `▓▒▒▒▒` for percentages.
*   **Footer:** Minimalist footer for IDs/Dates.

## 2. Feature-Specific Overhauls

### A. Live Signals (The "Dashboard")
**Current Issues:** Cluttered list, duplicates, missing context.
**New Design:**
*   **Aggregation:** **Strictly** one row per Token (Mint).
*   **Card Layout:**
    ```text
    🟢 ACORN (Acorn) 
    💎 x3.5 ATH | 💰 $120k MC | 🕓 5m ago
    ───────────────────────────
    👤 Earliest: @AlphaCaller (12:05)
    📢 Mentions: 5 Groups (Alpha, Beta, ...)
    🍬 Dex: Paid ✅ | 👥 Team: Doxxed
    📉 PnL: +120% (Entry: $0.001)
    ───────────────────────────
    [ 🔍 View Detail ] [ 📈 Chart ]
    ```
*   **Filters:**
    *   **Performance:** `>2x`, `>5x`, `>10x`.
    *   **Trends:** `Gainers` (Green), `Losers` (Red).
    *   **Custom:** `/filter gain > 50%` (Future).

### B. Recent Calls (The "Timeline")
**Current Issues:**
*   **Duplicates:** Same Group calls same Token multiple times -> Spam.
*   **Visuals:** messy text.
**Improvement:**
*   **Deduplication:** Ignore repeat calls from the *same group* for the *same token* within a 24h window (or show as "Re-call").
*   **Format:**
    ```text
    🕒 12:30 | 🟢 MEEP (MEEP)
    via 📢 Alpha Caller
    Entry: $0.003 → Cur: $0.004 (+33%)
    ```

### C. Group & User Analytics (The "Deep Dive")
**Current Issues:**
*   **Channel/User Disconnect:** Channels (no User ID) are not appearing in User Stats.
*   **Data Discrepancies:** Leaderboard shows 34x, Group Stats shows 3.6x.
*   **Missing Metrics:** Needs "7+ more metrics".
**New Metrics:**
1.  **Consistency Score:** Std Dev of returns (Are they lucky or consistent?).
2.  **Avg Peak Time:** How long does it take to hit ATH? (Scalper vs Holder).
3.  **Volume analysis:** Avg MC of calls (Whale vs Degen).
4.  **Honeypot Rate:** % of calls that are rug/scam.
5.  **Re-call Win Rate:** Do they call winners twice?
6.  **Follow-through:** % of calls that hold >2x for >1 hour.
7.  **Sniper Score:** Are they the *absolute* first?

**Action Plan:**
*   **Unified Entity Model:** Treat Channels as "Users" for analytics purposes if they lack a real user owner.
*   **Fix Query:** Ensure `GroupStats` and `Leaderboard` use the exact same `WHERE` clauses (likely `metrics IS NOT NULL` consistency).

### D. Cross-Group Intelligence
**Current Issues:** Just a list of tokens.
**New Feature: "Cluster Analysis"**
*   **Goal:** "Which groups confirm each other?"
*   **Output:**
    *   "Alpha Caller matches 80% with Beta Snipers."
    *   "When Alpha & Beta call together -> 90% Win Rate."
*   **Visual:** Matrix or Top Pairs list.

## 3. Implementation Steps

1.  **Core Data Fixes (High Priority)**
    *   **Fix Channel Logic:** Map `Channel` calls to a pseudo-User or distinct Entity ID so they appear in "Top Callers" logic correctly.
    *   **Verify Stats Query:** Debug why "Dih (34x)" didn't show in Alpha Caller's stats. (Likely date window or group ID mismatch).

2.  **UI Helper Expansion**
    *   Update `UIHelper` with the new "Card" designs.
    *   Add `renderSignalCard(signal, aggregatedData)` method.

3.  **Live Signals V2**
    *   Implement `getAggregatedActiveSignals`.
    *   Fetch `TokenMeta` (Dex/Socials).

4.  **Strategy Analysis Backend**
    *   Implement the "7 metrics" logic in `aggregator.ts`.
    *   Create the "Strategy Recommendation" engine.

## 4. Visual References (Text Mocks)

**Top Callers (Redesign)**
```text
🏆 LEADERBOARD (30D)
──────────────────
🥇 @Milaxionaire
   🎯 Score: 98 | 💎 34x Max
   ✅ 65% WR | 📉 -12% Avg DD
   
🥈 @SpyFly
   🎯 Score: 85 | 💎 12x Max
   ✅ 40% WR | 📉 -20% Avg DD
```

**Distribution (Redesign)**
```text
📊 DISTRIBUTION: Alpha Caller
──────────────────────────
💰 Market Cap Strategy
  < 10k:  ████░░ 60% WR (Best)
  10-50k: ██░░░░ 20% WR
  > 100k: ░░░░░░ 0% WR

⚠️ WARNING: 80% of calls >100k FAIL.
✅ ADVICE: Copy only <10k MC calls.
```

