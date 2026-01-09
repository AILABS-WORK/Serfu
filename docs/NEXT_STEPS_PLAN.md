# Next Steps: Anti-Spam, Isolation, Alerts, and Full Functionality

This plan ties together the PRD, BUILD_PLAN.md, and current implementation. It lists concrete engineering tasks, ownership/scoping rules, UX changes, testing, and rollout steps to ensure full functionality.

## 1) Anti-Spam Controls (Auto-Delete + Hide) — **Complete**
- **Auto-delete bot messages**: Delete bot-sent signal/alert cards after configurable TTL (per chat).
- **Hide button**: Inline “Hide” on bot cards; handles missing delete rights gracefully.
- **Settings**: `auto_delete_seconds` (0 = off), `show_hide_button` via /settings; per chat/owner.
- **Permissions**: Bot admin rights needed to delete; warn gracefully if missing.
- **Telemetry**: (Optional) add rate-limit flag later.

## 2) Data Isolation & Ownership (Private vs Shared) — **Complete**
- **Owner-scoped groups**: All group lists, destination lists, leaderboards, analytics, live signals must filter by `ownerId` (Telegram user ID). A user sees only groups they own.
- **Private “Serfu” workspace**: Your own groups/destinations stay private. Groups added by other users remain invisible to you and vice versa.
- **Destination groups**: When a user sets a destination, store under that user’s ownership; never surface in other users’ lists.
- **Cross-usage guardrails**: If a command references a group not owned by the caller, return a clear error. Prevent accidental leakage in menus and callbacks.
- **Channel support**: Channels are treated like groups; ownership is the posting user if available, else the channel id as owner surrogate.
- **Audit pass**: Review all queries:
  - `getAllGroups`, `getDestinationGroups`, leaderboards, distributions, live signals, analytics commands, and callbacks — ensure `ownerId` filter is applied.

## 3) Alerts to Owner (“Home”) + Repost Handling — **Complete**
- **First CA**: Send rich signal card to the posting chat and optionally to the owner’s “home” chat (config default ON). Includes group, user, entry price, MC, links (Solscan, Axiom, GMGN).
- **Repost CA**: Send “CA posted again” card with group/user context and price delta since first call; also optionally to the owner’s home chat.
- **Settings**:
  - `notify_home_on_first_ca` (default on)
  - `notify_home_on_repost` (default on)
- **Routing rules**: Source group owned by user A → alerts only to destinations and home of user A.

## 4) Analytics & UX Completeness
- **Per-group / per-user analytics**: Ensure metrics and leaderboards filter by ownerId and groupId. No cross-owner mixing.
- **Distributions & live signals**: Owner-scoped views only.
- **Signal card actions**: Add quick “Stats”/“Chart” buttons (already present) and ensure they respect ownership.
- **Testing**: Multi-owner scenarios to confirm isolation in commands, callbacks, and forwarded alerts.

## 5) Additional UX & Settings Coverage — **Complete**
- **Monitored Channels section**: In `/groups` (or main menu), show monitored channels separately from monitored groups; include status and counts.
- **Settings coverage**: Each major section (groups/channels, alerts, anti-spam, destinations, home chat) must expose settings via buttons/commands and persist per owner/chat.
- **Home chat selection**: Allow user to designate a “home” chat (group/channel/DM) where their own alerts are routed; default to the owner’s private workspace if set.
- **Group vs home bots**: If a bot is added directly to a group, that group is owned by the user who added it; if used as a private home, mark it as such and keep it isolated.
- **Destination-as-monitored**: When a destination is set, also list it in monitored items for that owner (but never leak to other owners).
- **Channel add UX**: Provide an explicit “Add Channel” path (instructions + buttons) so channels can be added, tracked, and listed just like groups.

## 6) Alerts & Signals (Expanded) — **Mostly Complete**
- **Threshold alerts**: 2x–100x price & MC routed per settings (group/destination/home/DM).
- **Event alerts**: dex paid, bonding, migrating; routed to destinations/home when enabled.
- **Cross-group awareness**: Destinations distinguish first vs new-group mention; owner-scoped duplicates persisted.
- **Destination alerts**: “NEW CA SIGNAL” for first; “New group mention” for other owned sources; deduped per source/destination.
- **Persisted duplicate tracking**: Owner-scoped in DB; survives restarts.
- **Nice-to-have**: richer event parsing and analytics logging.

## 7) Analytics Depth — **In Progress**
- ✅ Earliest callers (7d, owner-scoped) surfaced.
- ✅ Cross-group confirmations (7d) surfaced.
- ⚠️ Extend per-user/group performance drill-down (run-up/drawdown to cards/charts).
- ⚠️ Log/visualize event alerts and confirmations.

## 8) Data Freshness & Token Data Quality
- **Price freshness**: Implement re-fetch/refresh for price when rendering cards; consider short-term cache with expiry; note Helius 600s cache—force a fresh call where possible or retry.
- **ATH/volume/supply/MC accuracy**: Normalize supply with decimals; recompute MC = price_per_token * adjusted_supply; if missing, retry/backoff and flag low confidence.
- **Event detection**: Add bonding/migration/dex-paid parsing and alerting hooks; log events for analytics.
- **Threshold monitoring**: Ensure sampling loop continues after message deletion and uses persisted signals to trigger 2x–100x alerts.

## 8) Implementation Tasks (Step-by-Step)
1) **Anti-Spam** (status: in progress — code present; surface settings + verify perms)
   - ✅ Auto-delete scheduler per bot message (TTL, per-chat).
   - ✅ “Hide” button on cards; deletes bot message; handle missing delete rights gracefully.
   - ⚠️ Expose per-chat settings for TTL/hide toggle via command/UI.
   - ⚠️ Telemetry/feature flag for delete failures and rate limits.

2) **Isolation Hardening**
   - Audit and enforce ownerId in all DB accessors and command handlers (groups, destinations, analytics, leaderboards, live signals).
   - Add guardrails for unauthorized group references.
   - Verify channel ingestion respects ownership and doesn’t leak.

3) **Alerts Routing**
   - Add owner “home alerts” option; default on for first and repost CAs.
   - Wire routing so only the owner’s destinations + home chat receive the alert.
   - Confirm duplicate-CA logic runs for channels and groups.

4) **Settings Surface**
   - Add a simple settings entry (command or inline) to toggle:
     - auto_delete_seconds
     - hide button
     - home alerts (first/repost)
   - Persist per chat/owner.
   - Add “Set Home Chat” control; add monitored channels listing; ensure destinations appear in monitored list for the owning user only.
   - Add explicit “Add Channel” flow; show monitored channels section.

5) **Testing Plan**
   - Groups: Post CA in source group → card shows, auto-deletes in ~60s, hide works.
   - Channels: Post CA in channel → card shows, auto-deletes, hide works (if admin).
   - Repost: Post same CA in another group/channel → “CA posted again” card with delta.
   - Isolation: Two different users, each with their own source/destination; verify no cross-visibility in `/groups`, leaderboards, analytics.
   - Permissions: Bot without delete rights should not crash; logs warning.
   - Home chat: Set a home chat; verify alerts route there; change home and re-verify.
   - Monitored channels: Ensure channels appear in monitored list and respect ownership.
   - Destination alerts: Verify first/repost alerts arrive in destination groups with origin info (group/channel, user).
   - Duplicate persistence: Delete messages and repost CA; verify repost still detected as duplicate.
   - Price freshness: Re-query CA and confirm updated price; threshold alerts fire off persisted signals.
   - Jupiter search: `/testjup <mint>` returns fresh meta/price; cards display icon/links/meta.

6) **Docs & Ops**
   - Update COMMANDS_REFERENCE with settings toggles.
   - Update SETUP_GUIDE with required bot permissions (delete messages in groups/channels).
   - Note auto-delete defaults and how to override per chat.
   - Document home chat setup and monitored channels behavior; clarify ownership rules.
   - Document channel add flow and destination alert expectations.

## 9) Mapping to BUILD_PLAN.md / PRD
- BUILD_PLAN Phase 3/4: Ingestion + detection done; extending UX (cards) and adding anti-spam.
- PRD 4.1/4.2/4.4: Ingestion + signal detection covered; adding UX polish (spam control).
- PRD 3.1/2.3 constraints: Respect group privacy off; admin rights needed for deletion.
- PRD 4.5: Threshold alerts already implemented; routing respects ownership.

## 10) Rollout Steps
- Implement anti-spam + hide and owner-alert routing.
- Deploy to Railway.
- Test in:
  - Your private Serfu workspace (owner-only)
  - A shared group (other owner) to confirm isolation
  - A channel with bot as admin to confirm channel handling
- Monitor logs for delete failures and alert routing.

## 11) Card & Alerts Upgrade (New)
- **Richer cards**: Use Jupiter search meta (icon, price, MC, liquidity, supplies, 1h/24h change, links), show current vs entry price and MC deltas, keep Chart/Stats/Hide.
- **Entry snapshots**: Persist entry price and entry MC (price * supply) per signal to power deltas, run-up, and drawdown.
- **Threshold alerts**: Expand to 2x, 3x, 4x, 5x, 10x, 15x, 20x, 30x, 50x, 100x for both price and MC; honor per-user settings (DM/group/destination/home).
- **Settings**: Add toggles for price/MC thresholds and entry override in a simple settings flow.
- **Stats**: Show current vs entry % and MC % on cards; prep for deeper run-up/drawdown stats once time-series is stored.
