# Strategy Templates

Use these as starting points for `/strategy` and backtests.

---

## 1) Balanced Swing (Default)
Goal: mix reliability + upside.

Conditions:
- Entry MC: $10k – $200k
- Min Mentions: 2
- Schedule: All days, 24h

TP/SL:
- TP1: 2.5x sell 50%
- TP2: 4x sell 50%
- SL: 0.65x sell 100%

Use when:
- Win rate >= 40%
- Avg ATH >= 2.5x

---

## 2) High Return (Moonshot)
Goal: maximize upside, accept volatility.

Conditions:
- Entry MC: $5k – $150k
- Min Mentions: 1
- Schedule: Best hours only (from Distributions)

TP/SL:
- TP1: 3x sell 40%
- TP2: 5x sell 40%
- TP3: 8x sell 20%
- SL: 0.6x sell 100%

Use when:
- Avg ATH >= 4x
- Moon rate high

---

## 3) High Win Rate (Scalper)
Goal: consistency, low drawdown.

Conditions:
- Entry MC: $20k – $300k
- Min Mentions: 3
- Schedule: strongest hours by WR

TP/SL:
- TP1: 2x sell 50%
- TP2: 3x sell 50%
- SL: 0.7x sell 100%

Use when:
- Win rate >= 55%
- Drawdown small (< -20%)

---

## 4) Confluence‑Only
Goal: trade only multi‑source confirmations.

Conditions:
- Confluence >= 3 sources
- Entry MC: $10k – $200k
- Schedule: best day‑of‑week

TP/SL:
- TP1: 2.5x sell 40%
- TP2: 4x sell 40%
- TP3: 6x sell 20%
- SL: 0.65x sell 100%

Use when:
- Confluence bucket shows WR > 50%

---

## 5) Microcap Sniper
Goal: fastest movers, highest risk.

Conditions:
- Entry MC: < $15k
- Min Mentions: 1
- Schedule: best hours only

TP/SL:
- TP1: 2x sell 50%
- TP2: 4x sell 50%
- SL: 0.5x sell 100%

Use when:
- You have fast execution
- Distribution shows high avg x in <10k bucket

