# Next Steps: Anti-Spam, Isolation, Alerts, and Full Functionality

This plan ties together the PRD, BUILD_PLAN.md, and current implementation. It lists concrete engineering tasks, ownership/scoping rules, UX changes, testing, and rollout steps to ensure full functionality.

## 1) Anti-Spam Controls (Auto-Delete + Hide)
- **Auto-delete bot messages**: Delete bot-sent signal/alert cards after a configurable TTL (default 60s). Scope per chat (group/channel). Never delete user messages.
- **Hide button**: Add an inline “Hide” button on every bot card that immediately deletes that bot message. Handle missing delete rights gracefully and log failures.
- **Settings**:
  - `auto_delete_seconds` (per chat; 0 = off; default 60)
  - `show_hide_button` (default on)
- **Permissions**: Requires bot admin rights to delete its messages in groups/channels. If not granted, show a one-time warning and continue without deletion.
- **Telemetry**: Log deletions and failures to understand coverage; add a feature flag to disable globally if Telegram rate-limits.

## 2) Data Isolation & Ownership (Private vs Shared)
- **Owner-scoped groups**: All group lists, destination lists, leaderboards, analytics, live signals must filter by `ownerId` (Telegram user ID). A user sees only groups they own.
- **Private “Serfu” workspace**: Your own groups/destinations stay private. Groups added by other users remain invisible to you and vice versa.
- **Destination groups**: When a user sets a destination, store under that user’s ownership; never surface in other users’ lists.
- **Cross-usage guardrails**: If a command references a group not owned by the caller, return a clear error. Prevent accidental leakage in menus and callbacks.
- **Channel support**: Channels are treated like groups; ownership is the posting user if available, else the channel id as owner surrogate.
- **Audit pass**: Review all queries:
  - `getAllGroups`, `getDestinationGroups`, leaderboards, distributions, live signals, analytics commands, and callbacks — ensure `ownerId` filter is applied.

## 3) Alerts to Owner (“Home”) + Repost Handling
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

## 5) Additional UX & Settings Coverage
- **Monitored Channels section**: In `/groups` (or main menu), show monitored channels separately from monitored groups; include status and counts.
- **Settings coverage**: Each major section (groups/channels, alerts, anti-spam, destinations, home chat) must expose settings via buttons/commands and persist per owner/chat.
- **Home chat selection**: Allow user to designate a “home” chat (group/channel/DM) where their own alerts are routed; default to the owner’s private workspace if set.
- **Group vs home bots**: If a bot is added directly to a group, that group is owned by the user who added it; if used as a private home, mark it as such and keep it isolated.
- **Destination-as-monitored**: When a destination is set, also list it in monitored items for that owner (but never leak to other owners).

## 6) Alerts & Signals (Expanded)
- **Threshold alerts**: 2x, 3x, 4x, 5x, 10x, 15x, 20x, 30x, 50x, 100x from entry; route per owner settings (group, destination, home).
- **Event alerts**: bonding, migrating, new signal, CA repost; include group and user origin.
- **Cross-group awareness**: On reposts, include source group/user and price delta vs first call; log for analytics.

## 7) Analytics Depth
- Track which groups/users call first across multiple groups; earliest-call scoring.
- Cross-group confirmation: identify signals echoed across multiple groups and compare performance.
- Per-user performance across groups: where they post first, win rates, ATH multiples, time-to-2x.
- Group-level “earliest callers” and “best confirmations.”
- Ensure all analytics remain owner-scoped.

## 8) Implementation Tasks (Step-by-Step)
1) **Anti-Spam**
   - Add auto-delete scheduler per sent bot message (stores chatId, messageId, expiry).
   - Add inline “Hide” button to signal/alert cards; on press, delete the bot message.
   - Add per-chat settings (commands or inline settings) for TTL and hide toggle.
   - Handle permission failures gracefully; log telemetry.

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

5) **Testing Plan**
   - Groups: Post CA in source group → card shows, auto-deletes in ~60s, hide works.
   - Channels: Post CA in channel → card shows, auto-deletes, hide works (if admin).
   - Repost: Post same CA in another group/channel → “CA posted again” card with delta.
   - Isolation: Two different users, each with their own source/destination; verify no cross-visibility in `/groups`, leaderboards, analytics.
   - Permissions: Bot without delete rights should not crash; logs warning.
   - Home chat: Set a home chat; verify alerts route there; change home and re-verify.
   - Monitored channels: Ensure channels appear in monitored list and respect ownership.

6) **Docs & Ops**
   - Update COMMANDS_REFERENCE with settings toggles.
   - Update SETUP_GUIDE with required bot permissions (delete messages in groups/channels).
   - Note auto-delete defaults and how to override per chat.
   - Document home chat setup and monitored channels behavior; clarify ownership rules.

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


