# Backtesting Guide

This guide explains how to validate that backtests are working and what
coverage is required for reliable results.

---

## 1) Coverage Requirements
Backtests are only reliable when metrics coverage is high.

Minimum recommended coverage:
- ATH: 80%+
- Time to ATH: 60%+
- Drawdown: 80%+

The `/strategy backtest` output now displays coverage directly.

---

## 2) How Backtests Work
Inputs:
- Entry price/time
- ATH multiple
- Max drawdown (percent)
- Time to ATH / drawdown duration
- TP/SL rules

Outputs:
- Win rate
- Avg multiple
- Avg ROI/trade
- Max drawdown (portfolio)
- Return %

---

## 3) Test Procedure
1) Run `/strategy` and choose target (Group/User/Overall).
2) Select a timeframe (7D/30D/ALL).
3) Run **Backtest**.
4) Confirm coverage >= recommended thresholds.
5) Compare output vs expectations from Distributions.

---

## 4) Smoke Test Script
You can run:
```
node scripts/backtest_smoke.js
```

This checks:
- Signals exist
- Coverage % is acceptable
- Backtest executes without error

---

## 5) Troubleshooting
- **Low coverage**: run ATH enrichment cycle or wait for background jobs.
- **0 signals**: verify group ownership + timeframe.
- **Unexpected results**: verify entry MC bucket and schedule filters.

