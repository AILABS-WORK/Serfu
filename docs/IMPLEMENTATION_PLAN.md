# Implementation Plan: Card & Alerts Upgrade

## Scope
- Jupiter search–driven cards with richer meta (icon, price, MC, liquidity, supplies, 1h/24h change, links).
- Entry snapshots (price, MC, supply) per signal.
- Threshold alerts for price and MC (2x, 3x, 4x, 5x, 10x, 15x, 20x, 30x, 50x, 100x) honoring per-user settings (DM/group/destination/home).
- Settings surface for thresholds and entry override.
- Display current vs entry deltas on cards; prepare for run-up/drawdown metrics.

## Work Breakdown
1) Data capture
   - Store entryPrice, entryPriceAt, entryMarketCap (price * supply), and supply snapshot on signal creation.
   - If supply missing, default to Jupiter circ/total supply; fallback to Helius supply/decimals.

2) Card redesign
   - Update `generateFirstSignalCard` and `generateDuplicateSignalCard` to:
     - Show icon, name/symbol, price, MC, liquidity, supplies, 1h/24h change.
     - Add current vs entry price % and MC %.
     - Keep Chart/Stats/Hide actions; retain links (Solscan, Axiom, GMGN, socials).

3) Alerts expansion
   - Extend price alerts job to cover 2x–100x and add MC-based thresholds using stored entry MC.
   - Honor per-user notification settings (DM, group, destination, home) and avoid duplicate sends.
   - Add settings fields for MC thresholds (e.g., alertMc2x, alertMc3x, … alertMc100x).

4) Settings surface
   - Add a simple `/settings` (or inline) flow to toggle:
     - Price thresholds, MC thresholds.
     - Entry price override (optional).
     - Existing anti-spam toggles (TTL, hide) and home-alert toggles.

5) Testing
   - `/testjup <mint>` returns search data (already live); cards render icon/meta.
   - Post CA, verify card shows deltas and icon; auto-delete/hide still works.
   - Trigger price and MC thresholds; confirm delivery to destination/home/DM as configured.
   - Repost CA → duplicate card still works with deltas; no cross-owner leakage.

## Status
- Done: card redesign, alerts expansion (price & MC), settings surface, anti-spam surface, home routing.
- Done: Jupiter search primary meta, `/testjup` search-only output.
- In progress: deeper analytics surfacing (earliest callers, confirmations, run-up/drawdown visibility).


