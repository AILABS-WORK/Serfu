# Remediation & Enhancement Plan

This plan addresses the broken behaviors you observed (settings not working, destination alerts missing, cards not using the rich Jupiter data), and extends metrics/strategies to deliver deeper insights and copy-trading value.

## 0) Triage & Verification (fast checks)
- Confirm migrations applied: run `prisma migrate deploy` to ensure `auto_delete_seconds`, `show_hide_button`, home flags exist.
- Verify BOT_TOKEN and JUPITER_API_KEY/JUP_API_KEY are set in env.
- Run a quick `/testjup <mint>` in bot to confirm Jupiter search returns fresh MC/price.

## 1) Fix broken UX (Settings & Cards)
- Settings callbacks not responding: audit action handlers and ensure the inline keyboard in `Settings` uses live callback_data; add logging on settings actions.
- Ensure per-chat TTL/hide is read and applied in notifier/forwarder/home/dest; show current values in Settings reply.
- Restore rich card rendering:
  - Force metadata source to Jupiter search only for cards (fall back to Helius only if Jupiter fails).
  - Include image/icon, MC, price, liquidity, supply, 1h/24h change, links.
  - Ensure duplicate cards also use live Jupiter price/MC, not stale entry values.

## 2) Alerts & Routing reliability
- Destination alerts: add tracing logs for forwarder decisions (first vs new-group mention) and ensure dedupe only blocks repeats from the same source, not from different sources.
- Home alerts: verify first/repost toggles respected; log when suppressed.
- Event alerts: confirm dex-paid/bonding/migrating send to destinations/home; add minimal throttling to avoid spam.
- Sampling/thresholds: ensure MC/price alerts fetch fresh quote before evaluating thresholds.

## 3) Data freshness & accuracy
- Make Jupiter search the primary metadata/price path for cards and alerts; Helius only as a fallback.
- On each notification, re-fetch a fresh Jupiter price to avoid stale entry values; recompute MC = price * supply.
- Add short-lived cache (e.g., 15–30s) to reduce spam, but force refresh for notifications.

## 4) Metrics & Analytics upgrades
- Group metrics:
  - Show chronological list of calls with entry time, run-up, drawdown, current PnL.
  - Add per-group summary: avg/max run-up, max drawdown, time-to-2x/3x/5x, hit rates, count of confirmations across groups.
- User metrics:
  - Similar run-up/drawdown, time-to-2x/3x/5x, consistency, win rate, median/percentile ATH.
  - Earliest-caller score and confirmation score (signals echoed by others).
- Signals stats surface:
  - In Stats action, add run-up, drawdown, time-to-ATH, time-to-2x/3x/5x where available.
- Cross-group confirmations:
  - List recent mints with multiple owned-source mentions and their performance since first call.

## 5) Strategy recommendations (copy-trading refinement)
- For groups: rank by earliest-call performance, hit rates, avg run-up, drawdown.
- For users: rank by earliest-call score, consistency, ATH multiples, time-to-2x.
- Provide a “follow this group/user” suggestion with rationale (top 3 signals and their outcomes).

## 6) Testing matrix (must pass)
- Settings: toggles for TTL/hide/home alerts change state and reflect in /settings; TTL/hide applied to cards in that chat.
- Cards: rich Jupiter-based cards show icon/meta; duplicate cards show current price/MC vs entry with deltas.
- Destination routing: first CA sends to destination; new group mention sends once per new source; no repeats from same source spam.
- Home routing: first/repost toggles honored; no double-send if home == source/destination.
- Event alerts: dex-paid/bonding/migrating messages trigger alerts to destination/home; no crashes without delete rights.
- Thresholds: price/MC alerts fire once per threshold using fresh price; honor per-chat TTL/hide.
- Analytics: earliest callers and cross-group confirms populate from owned groups only; leaderboards scoped to owner workspace.
- Channel flow: add bot as admin, claim channel, post CA → shows in /groups Channels and routes alerts.

## 7) Rollout steps
- Apply migration; redeploy.
- Smoke test in a staging chat set (source, destination, home).
- Run test matrix above; capture logs for forwarder/notifier/settings actions.
- If stable, promote to production.

