TITLE: Comprehensive Optimization Plan from January Feedback
VERSION: 1.0
STATUS: DRAFT
OWNER: Serfu Team
DATE: 2026-01-14

SCOPE
1. Purpose: Translate the latest UI/UX and analytics feedback into a detailed, actionable plan.
2. Audience: Product, Engineering, and QA.
3. Sources: Telegram screenshots and user feedback collected on 2026-01-14.
4. Priority: High, since the feedback highlights inaccuracies and missing features.
5. Out of Scope: New external integrations beyond existing providers unless specified as optional.

SUMMARY OF MAIN PROBLEMS
1. Distributions header and target context are unclear.
2. Targeting (overall vs group vs user) is missing in distribution views.
3. Time-of-day analysis is too sparse and needs better presentation and detail.
4. Volume correlation and rug pull analyses appear inaccurate or incomplete.
5. Token age buckets are too coarse and need finer granularity.
6. Time-to-x metrics need consistent presence across analytics views.
7. Recent activity uses price; must use market cap and consistent formatting.
8. Leaderboards and analytics need 1D/7D/30D/ALL plus custom timeframe input.
9. Cross-group insights need additional performance context (e.g., % moved by time of second call).
10. Strategy creation should be a first-class menu item.
11. Monitored channels show 0 signals for Alpha caller despite known data.
12. Strategy creator lacks scheduling and conditional logic (days/times, volume, mentions).
13. Live signals sorting/filters lack current 2x/5x and ATH display.
14. Signal leaderboards missing ATH/current MC and time-to-ATH accuracy.
15. Distributions missing a large portion of source channel calls.

GUIDING PRINCIPLES
1. All performance metrics must use market cap, not price.
2. Market cap formatting should be compact (K/M/B) with precision:
   - < 1M: 1 decimal place (e.g., $452.3K)
   - >= 1M: 2-3 decimals (e.g., $1.23M)
3. Any view that shows time windows must support 1D/7D/30D/ALL and custom windows.
4. Custom windows: input in H, D, W, M (e.g., 6H, 3D, 2W, 1M).
5. Default behavior must not spam new messages; edit existing messages when filtering.
6. Any analysis with sparse data must show a short note about data sufficiency.

SECTION A: DISTRIBUTIONS OVERHAUL
A1. Rename "Market Cap Strategy (30D)" to "Distributions (30D)".
A2. Add visible target context at top of all distribution views:
   - Target: Overall
   - Target: Group: <Group Name>
   - Target: User: <User Name>
A3. Add a target selector:
   - Button: Target: Overall
   - Button: Target: Group
   - Button: Target: User
A4. Target selection should persist across distribution subviews.
A5. Target selection should be stored in session and not reset on view change.
A6. Provide a fallback if user has no groups/users: show overall only.
A7. Add a short summary line for each distribution view, e.g.:
   - "Based on X calls in timeframe Y"
A8. Add call count to all distribution rows or sections to show sample size.
A9. Ensure distribution calculations are market-cap based where relevant.
A10. Add a "Change Timeframe" button accessible from all distribution views.
A11. Add a "Custom Timeframe" button that prompts input with format hint.
A12. Validate timeframe input: H, D, W, M.
A13. Clamp absurdly large windows to a maximum (e.g., 365D).
A14. Add a "Reset to Default" button for time and target.
A15. Add empty-state handling: if no signals in timeframe, show a message.

SECTION B: MARKET CAP DISTRIBUTIONS
B1. Replace "Market Cap Strategy" header with "Distributions".
B2. Keep the market cap bucket display as the default "MCap Distribution".
B3. Buckets should be:
   - < 10k
   - 10k-20k
   - 20k-50k
   - 50k-100k
   - 100k-250k
   - 250k-500k
   - 500k-1M
   - 1M+
B4. For each bucket show:
   - Win Rate
   - Avg Multiple
   - Count
B5. Add "Best Range" summary:
   - show highest win rate or highest avg multiple based on a toggle.
B6. Add toggle:
   - "Best by Win Rate"
   - "Best by Avg Multiple"
B7. Use icons: green for better, yellow for medium, red for poor.
B8. Add tooltips or short hints for bucket definitions.
B9. Display entry MC for each signal in bucket calculations.
B10. Ensure "Win Rate" uses market cap multiples.

SECTION C: TIME OF DAY ANALYSIS
C1. Replace current "Best Hours to Trade" with a full-day breakdown.
C2. Display hourly buckets (00-01, 01-02, ... 23-24).
C3. For each hour show:
   - Calls
   - Win Rate
   - Avg Multiple
C4. Provide a compact view: top 5 hours by win rate.
C5. Provide a full view: all 24 hours via a button toggle.
C6. Add time-of-day heatmap style using emojis or bars:
   - Use ▮▮ for higher win rate, ▮ for medium, ░ for low.
C7. Include timezone indicator in header (UTC or user-selected).
C8. Add "Time of Day by Day of Week" view:
   - Allow user to pick a day (Mon-Sun).
   - Show hourly breakdown for that day.
C9. Add "Top Hours per Day" summary:
   - For each day, show best hour and win rate.
C10. Add "Best Overall Hours" summary across all days.
C11. Ensure calculations use signal detected time.
C12. If detectedAt missing, skip.

SECTION D: DAY OF WEEK ANALYSIS
D1. Keep day-of-week summary but add:
   - Total calls
   - Avg multiple
   - Median multiple
D2. Add day-of-week breakdown with time-of-day subview (link to C8).
D3. Add "Best Day" summary with win rate and avg multiple.
D4. Add "Worst Day" summary.
D5. Use consistent formatting for day labels.
D6. Include sample size to avoid misleading results.

SECTION E: GROUP WIN RATE COMPARISON
E1. Maintain group win rate comparison but add:
   - Avg entry MC
   - Avg ATH multiple
   - Avg time to ATH
E2. Add "Moon Rate" (>5x) for each group.
E3. Add "Signal Count" for each group.
E4. Add "Top Calls" summary: best call with multiple and entry MC.
E5. Provide a toggle:
   - Sort by Win Rate
   - Sort by Avg Multiple
   - Sort by Moon Rate
E6. Use market cap for all metrics.
E7. Add "Time to 2x/5x/10x" averages per group.

SECTION F: VOLUME CORRELATION
F1. Current view shows zeros; needs real data.
F2. Define volume correlation based on:
   - Volume at 5m/1h/24h after entry.
   - Use provider stats windows (stats5m/stats1h/stats24h) if available.
F3. Introduce volume buckets:
   - 0-1k
   - 1k-5k
   - 5k-10k
   - 10k-25k
   - 25k-50k
   - 50k-100k
   - 100k+
F4. For each bucket, show:
   - Win Rate
   - Avg Multiple
   - Count
F5. Add a toggle for volume window:
   - 5m
   - 1h
   - 24h
F6. If volume data is missing, show "Insufficient volume data".
F7. Provide note: "Volume data depends on provider coverage."
F8. Use "calls with volume recorded" instead of all calls.
F9. Add “Best volume bucket” summary.
F10. Add “Worst volume bucket” summary.

SECTION G: RUG PULL ANALYSIS
G1. Keep definition: ATH < 0.5x OR Drawdown > 90%.
G2. Add time constraint:
   - Rug criteria within X hours of entry (default: 24h).
G3. Allow timeframe change (1h, 6h, 24h, 72h).
G4. Add "Rug Speed" average: time to reach rug criteria.
G5. Show total count and percentage.
G6. Add small note: "Computed using market cap samples."
G7. If no samples, show "Not enough samples."
G8. Add "Rug by Market Cap Bucket" optional subview.

SECTION H: MOONSHOT PROBABILITY
H1. Add target selection: overall/group/user.
H2. Show moonshot counts:
   - >2x
   - >5x
   - >10x
H3. Show percentages and counts.
H4. Add "Time to Moonshot" average (2x/5x/10x).
H5. Add "Moonshot by Market Cap Bucket" optional subview.
H6. Add caution if sample size is low.

SECTION I: STREAK ANALYSIS
I1. Expand current streak analysis:
   - After 1 loss
   - After 2 losses
   - After 3 losses
   - After 1 win
   - After 2 wins
   - After 3 wins
I2. For each case show next-win rate and count.
I3. Add "Longest Win Streak" and "Longest Loss Streak".
I4. Add "Current Streak" for group/user.
I5. Provide a brief explanation of streak calculation.
I6. Add mean time between wins for the target.

SECTION J: TOKEN AGE PREFERENCE
J1. Replace two buckets with finer breakdown:
   - 0-5m
   - 5-15m
   - 15-45m
   - 45m-2h
   - 2h-6h
   - 6h-24h
   - 1d-7d
   - 7d+
J2. For each bucket show:
   - Win Rate
   - Avg Multiple
   - Count
J3. Add "Best Age Range" summary.
J4. Add "Most Common Age Range" summary.
J5. Add a note if token age data is missing or inferred.

SECTION K: LIQUIDITY VS RETURN
K1. Ensure liquidity data is based on provider data, not defaults.
K2. Add liquidity buckets:
   - 0-5k
   - 5k-10k
   - 10k-25k
   - 25k-50k
   - 50k-100k
   - 100k+
K3. For each bucket show win rate, avg multiple, count.
K4. Add "Best Liquidity Bucket" summary.
K5. Add "Liquidity by Market Cap" optional subview.

SECTION L: TIME-TO-X METRICS
L1. Ensure time-to-2x, 5x, 10x are computed in minutes.
L2. Add to:
   - Group Analytics
   - User Analytics
   - Distributions (summary)
L3. Display in a consistent format:
   - Under 1h: "45m"
   - 1h+: "2.3h"
   - 24h+: "3.2d"
L4. Use market cap multiples only.
L5. Add "Time-to-ATH" in all main analytics views.
L6. Add "Time-to-2x/5x/10x" in group/user details.

SECTION M: RECENT ACTIVITY LOG
M1. Replace price with market cap for entry/current.
M2. Show entry MC, current MC, and percent change.
M3. Use 1 decimal for K, 2-3 decimals for M.
M4. Add a compact label:
   - "Entry MC: $xx.xK -> Now: $yy.yK"
M5. Add peak multiple using market cap.
M6. Add a small indicator for win/lose using color icon.
M7. Keep a clean, readable layout.

SECTION BG: LIVE SIGNALS (SORT + FILTER + ATH DISPLAY)
BG1. Add sort option for "Most Recent" using latest call time.
BG2. Add filters for "Currently >2x" and "Currently >5x" based on current MC vs entry MC.
BG3. When >2x/>5x filters are active, only include calls detected in last 24h.
BG4. Live signals line must show:
   - Entry MC ➔ Now MC with % change
   - ATH multiple label (e.g., "4x ATH")
BG5. Ensure filters apply to all active signals (including forwarded/destination).
BG6. If ATH is missing, show "ATH N/A" but still show entry/now MC.

SECTION N: LEADERBOARDS AND TIMEFRAMES
N1. Add 1D to all leaderboard selectors.
N2. Add 3D as optional quick button.
N3. Add custom input:
   - Button: Custom Range
   - Prompt: "Enter timeframe (e.g., 6H, 3D, 2W, 1M)"
N4. Validate input and respond with errors if invalid.
N5. Store custom timeframe per user session.
N6. Apply custom timeframe to:
   - Leaderboards
   - Distributions
   - Recent Activity
   - User/Group Analytics
N7. Add a small tag in header showing timeframe source:
   - "Timeframe: Custom (3D)"
N8. Signal leaderboard must display:
   - Entry MC, ATH MC, Current MC
   - Time to ATH (derived from metrics.timeToAth or athAt)
N9. Use fallbacks for missing MC:
   - currentMarketCap from metrics or price*supply
   - athMarketCap from metrics or entryMC*athMultiple

SECTION O: FIRST CALLERS
O1. Keep top first callers but add:
   - Avg entry MC
   - Avg ATH MC
   - Avg time to ATH
O2. Add a toggle:
   - By Wins
   - By Avg Multiple
   - By First-Call Count
O3. Show sample size for each entry.
O4. Add note: "First call determined by earliest detection timestamp."

SECTION P: LAG MATRIX
P1. Extend lag matrix rows to show:
   - Avg lag in minutes
   - Avg MC change when second group calls
P2. Example: "Leads by 18m | MC +32%"
P3. Add "Median lag" and "P75 lag" in detail view.
P4. Add a short explanatory note in the header.
P5. Ensure all lag computations use detectedAt times.

SECTION Q: CONFLUENCE WIN RATE
Q1. Keep shared calls and win rate.
Q2. Add:
   - Avg multiple for shared calls
   - Avg time to ATH
Q3. Add breakdown for shared calls >2x, >5x, >10x.
Q4. Add "Confluence Impact" summary if possible:
   - Average lift vs each group's baseline win rate.

SECTION R: UNIQUE SIGNAL RATIO
R1. Keep unique ratio view.
R2. Add total unique count.
R3. Add "Unique win rate" for unique-only calls.
R4. Add "Unique avg multiple".
R5. Keep clean layout and avoid clutter.

SECTION S: CLUSTER GRAPH
S1. Keep cluster entries.
S2. Add:
   - Avg time between calls in cluster.
   - Shared call count threshold used.
S3. Add "Correlation Score" if possible.
S4. Provide a short legend for interpretation.

SECTION T: COPY-TRADE LEAD IDENTIFICATION
T1. Keep lead identification list.
T2. Add:
   - Avg lag lead time
   - Avg multiple of calls by leader
T3. Show "Lead consistency" (% pairs led).
T4. Add "Lead quality" (win rate of led calls).
T5. Allow sorting by lead count or lead win rate.

SECTION U: USER ANALYTICS
U1. Add:
   - Avg time to ATH
   - Avg time to 2x / 5x / 10x
   - Count of >2x, >5x, >10x
U2. Add "Streak length" and "Current streak".
U3. Add "Moon count" and "Moon rate".
U4. Add "Avg entry MC" and "Avg ATH MC".
U5. Keep concise formatting and avoid overflow.
U6. Maintain market cap-based metrics only.

SECTION V: GROUP ANALYTICS
V1. Mirror all additions from User Analytics:
   - Avg time to ATH
   - Avg time to 2x / 5x / 10x
   - Moon count / rate
   - Avg entry MC and avg ATH MC
V2. Add "Most frequent entry bucket".
V3. Add "Best time-of-day for group".

SECTION W: STRATEGY CREATION
W1. Add "Strategy" to main menu.
W2. Strategy menu options:
   - Create New Strategy
   - View Existing Strategies
   - Simulate Strategy
W3. Strategy inputs:
   - Target type: Group/User/Overall
   - Timeframe
   - Min MC / Max MC
   - Min volume after entry
   - Min win rate threshold
W4. Strategy outputs:
   - Recommended targets
   - Expected win rate
   - Expected avg multiple
W5. Add "Follow Strategy" toggles.
W6. Add "Unfollow Strategy" options.
W7. Add schedule controls:
   - Active days (Mon-Sun toggles)
   - Active time windows (start/end, multiple windows allowed)
   - Timezone selection (default: UTC)
   - Optional "quiet hours" blocks
W8. Add conditional gates:
   - Wait for daily volume to reach X (per token or market-wide)
   - Require N mentions in last T (X/Twitter or Telegram, optional if supported)
   - Require minimum number of group/user calls before entry
   - Exclude if token age outside range
W9. Add "Entry timing" rules:
   - Enter at first call vs second call
   - Delay entry by X minutes
   - Skip if MC has already moved > Y%
W10. Add "Risk controls":
   - Max simultaneous open positions (soft limit for alerts)
   - Max signals per day
   - Blacklist/whitelist groups/users
W11. Add "Explain Strategy" preview:
   - Plain-language summary of active rules
   - Example "Would trigger" vs "Would skip" rationale.
W12. Strategy persistence:
   - Save as presets
   - Enable/disable without deleting
   - Track performance per strategy over time.

SECTION X: MONITORED GROUPS AND CHANNELS
X1. Monitored channels show 0 signals even when data exists.
X2. Fix to display signal count for channels:
   - Ensure counts are aggregated by chatId and ownerId.
X3. Add "Last signal" time for each group/channel.
X4. Add "Top calls" count for each group/channel (optional).
X5. Ensure channel signals not miscounted due to null userId.

SECTION Y: TARGET SELECTOR IMPLEMENTATION
Y1. Add a generic selector component used across views.
Y2. For distributions, group analytics, and user analytics.
Y3. Provide a back button to reset to overall.
Y4. Store selection in session and clear on logout.
Y5. Include target in header of all views.

SECTION Z: PERFORMANCE AND UX
Z1. Use message edits on filter actions, not new messages.
Z2. Avoid repeated "Loading..." messages in live signals.
Z3. Use batched data fetches where possible.
Z4. Cache token meta for short durations to reduce load.
Z5. Display a "refresh" indicator only when needed.

SECTION AA: DATA QUALITY AND SAFETY
AA1. If data missing, show "N/A" with brief note.
AA2. If samples are low (<10), show a caution label.
AA3. Ensure all calculations use market cap, not price.
AA4. Invalidate calculations where entry MC is missing.
AA5. Log errors with context for debugging.

SECTION AB: UI POLISH
AB1. Standardize separators and spacing in messages.
AB2. Keep consistent emoji use (avoid mixing similar).
AB3. Use compact lines for stats and avoid wrapping.
AB4. Use bold titles and minimal noise.
AB5. For lists, keep max 10 items unless requested.

SECTION AC: RECENT ACTIVITY VISUALS
AC1. Add small icons for movement:
   - Up arrow for gains
   - Down arrow for losses
AC2. Add a short line for "Peak MC" and "Peak multiple".
AC3. Provide quick context (group/user).

SECTION AD: IMPLEMENTATION TASKS (HIGH LEVEL)
AD1. Update UI text for distribution headers.
AD2. Add target selection to distributions.
AD3. Expand time-of-day view and add day-specific subview.
AD4. Extend token age buckets.
AD5. Add volume correlation and fix data calculations.
AD6. Add time-to-x metrics to analytics outputs.
AD7. Add custom timeframe input parsing.
AD8. Add strategy menu to main menu.
AD9. Fix channel signal counts in monitored groups.
AD10. Add strategy scheduling + conditional rules support.
AD11. Fix live signals filters/sorts and ATH display.
AD12. Fix signal leaderboard MC/ATH/time-to-ATH fallbacks.
AD13. Fix distributions scope to include missing source channel calls.

SECTION AE: DATABASE AND MODEL CONSIDERATIONS
AE1. Ensure SignalMetric has:
   - timeTo2x
   - timeTo5x
   - timeTo10x
   - athMarketCap
AE2. Ensure PriceSample has marketCap for each sample.
AE3. Ensure Signal has entryMarketCap and entrySupply.
AE4. Add indexes if new queries become heavy:
   - detectedAt
   - groupId
   - userId
   - mint

SECTION AF: CALCULATION DETAILS
AF1. Win Rate: ATH multiple > 2x (market cap).
AF2. Moon Rate: ATH multiple > 5x (market cap).
AF3. Rug: ATH < 0.5x or drawdown > 90% within timeframe.
AF4. Time to ATH: first sample at ATH market cap.
AF5. Time to 2x/5x/10x: first sample reaching multiple.
AF6. Avg entry MC: mean of entryMarketCap for signals.
AF7. Avg ATH MC: mean of athMarketCap for signals.
AF8. Avg time to X: mean of time values (minutes).

SECTION AG: DATA FETCHING STRATEGY
AG1. Use batch price fetching for live signals.
AG2. Only fetch meta for top 10 rows.
AG3. Reuse cached token meta when possible.
AG4. Avoid repeated queries per signal inside loops.

SECTION AH: VALIDATION AND QA
AH1. Create QA scripts for:
   - Custom timeframe input parsing
   - Time-to-x calculations
   - Distribution bucket accuracy
   - Volume correlation correctness
AH2. Add unit tests for:
   - Timeframe parsing
   - Bucket assignment
   - Rug definition with time constraint
AH3. Create QA checklist for UI:
   - Formatting
   - Target selection persistence
   - Message edits vs new messages
AH4. Test with sample data sets of different sizes.

SECTION AI: ROLLOUT PLAN
AI1. Phase 1: Distribution renaming, target selection, time-of-day enhancements.
AI2. Phase 2: Volume correlation, rug time constraint, token age buckets.
AI3. Phase 3: Time-to-x metrics across analytics and leaderboards.
AI4. Phase 4: Custom timeframe input and strategy menu.
AI5. Phase 5: Strategy scheduling and conditional rules.
AI6. Phase 6: Channel signal count fixes and UX polish.

SECTION AJ: OPEN QUESTIONS
AJ1. Should "Overall" target include forwarded signals or only source groups?
AJ2. Should time-to-x calculations ignore signals with entry MC missing?
AJ3. Should "Moonshot" threshold be configurable per user?
AJ4. Preferred timezone for time-of-day analysis.
AJ5. Which social sources are approved for "mentions" (X/Twitter, Telegram, Discord)?
AJ6. Should strategy rules apply to alerts only or also copy-trade execution?

SECTION AK: NEW FEATURES (SUGGESTED)
AK1. Add "Performance Alerts" for sudden spikes in win rate.
AK2. Add "Best Time of Day" daily summary in DM.
AK3. Add "Strategy Recommendations" based on user goals.
AK4. Add "Trendline" for win rate over time.
AK5. Add "Group vs User" comparison charts.
AK6. Add "Strategy Scheduler" with active days/times.
AK7. Add "Conditional Copy-Trade Rules" (volume/mentions/call count).
AK8. Add "Strategy Explainability" preview.

SECTION AL: SECURITY AND PRIVACY
AL1. Ensure user-specific targeting uses correct owner scopes.
AL2. Do not leak group stats between users.
AL3. Validate that channel signals are linked to correct owner.

SECTION AM: REQUIREMENTS TRACEABILITY
AM1. Distribution target selection -> A2-A6.
AM2. Time of day improvements -> C1-C11.
AM3. Volume correlation fix -> F1-F10.
AM4. Rug time constraints -> G1-G8.
AM5. Token age buckets -> J1-J5.
AM6. Time-to-x metrics -> L1-L6.
AM7. Market cap formatting -> Guiding Principles #2.
AM8. Avoid repeated loading -> Guiding Principles #5.
AM9. Strategy menu -> W1-W6.
AM10. Channel signals count -> X1-X5.

SECTION AN: DELIVERY CHECKLIST
AN1. Update distributions header and target selector.
AN2. Add per-day time-of-day view.
AN3. Implement volume window toggle and bucket stats.
AN4. Add expanded token age buckets.
AN5. Add time-to-x to group/user analytics.
AN6. Add custom timeframe input.
AN7. Add strategy menu in main menu.
AN8. Fix monitored channels signal counts.

SECTION AO: ACCEPTANCE CRITERIA
AO1. Distributions display target and allow selection.
AO2. Time-of-day view shows all hours and top hours.
AO3. Volume correlation shows non-zero results with data.
AO4. Token age view shows new buckets.
AO5. Time-to-x metrics are visible and accurate.
AO6. Recent activity uses market cap with correct format.
AO7. Custom timeframe input works and validates.
AO8. Channel signal counts display correct non-zero data.
AO9. All analytics use market cap, no price usage.
AO10. Views edit messages rather than posting new ones.
AO11. Strategy builder supports day/time scheduling and timezone.
AO12. Strategy builder supports conditional gates (volume/mentions/call count).
AO13. Live signals can sort by most recent and filter current >2x/>5x (last 24h).
AO14. Live signals show entry/now MC with % and ATH multiple label.
AO15. Signal leaderboard shows entry/ATH/current MC and correct time-to-ATH.
AO16. Distributions include calls from source channels in scope.

SECTION AP: IMPLEMENTATION DETAILS (FILES)
AP1. `src/bot/commands/analytics.ts`:
   - Update distributions UI
   - Add target selection
   - Add time-of-day expanded view
AP2. `src/analytics/aggregator.ts`:
   - Add volume correlation calculations
   - Add token age bucket calculations
AP3. `src/utils/ui.ts`:
   - Add formatting utilities for market cap precision
AP4. `src/bot/actions.ts`:
   - Add callbacks for target selection
   - Add custom timeframe input parsing
AP5. `src/analytics/metrics.ts`:
   - Ensure time-to-x data is recorded

SECTION AQ: DATA MODEL NOTES
AQ1. If any new fields are needed, list them here.
AQ2. Prefer computed metrics over storing derived values unless needed.
AQ3. If storing, ensure migrations are added and deploy-ready.

SECTION AR: CUSTOM TIMEFRAME PARSING
AR1. Accept H, D, W, M suffix.
AR2. Accept uppercase or lowercase input.
AR3. Clamp values to avoid extreme queries.
AR4. Provide helpful error messages:
   - "Invalid timeframe. Use 6H, 3D, 2W, 1M."
AR5. Store parsed window in session.

SECTION AS: DISTRIBUTIONS TARGET SELECTION WORKFLOW
AS1. User clicks "Target: Overall".
AS2. Bot shows buttons for Groups/Users.
AS3. User picks group or user.
AS4. Bot re-renders distributions with target applied.
AS5. Add "Change Target" button to revert.

SECTION AT: TIME-OF-DAY BY DAY VIEW
AT1. When user selects "Day of Week", add "View Hourly".
AT2. Show 24-hour table for that specific day.
AT3. Add "Best Hour" summary for that day.
AT4. Add "Worst Hour" summary for that day.

SECTION AU: VOLUME CORRELATION CALCULATION DETAILS
AU1. For each signal, pull stats5m/stats1h/stats24h.
AU2. Determine volume value for chosen window.
AU3. Assign bucket based on volume.
AU4. Compute win rate and avg multiple for bucket.
AU5. Ignore signals without volume data for chosen window.

SECTION AV: RUG TIME CONSTRAINT DETAILS
AV1. When calculating drawdown, detect time to drawdown.
AV2. Only count as rug if drawdown within X hours.
AV3. X hours configurable via input or preset buttons.

SECTION AW: MARKET CAP FORMAT SPEC
AW1. 0 or null -> "N/A"
AW2. 1,234 -> "$1.2K"
AW3. 12,345 -> "$12.3K"
AW4. 123,456 -> "$123.5K"
AW5. 1,234,567 -> "$1.23M"
AW6. 12,345,678 -> "$12.35M"
AW7. 123,456,789 -> "$123.46M"
AW8. 1,234,567,890 -> "$1.23B"

SECTION AX: CHANNEL SIGNAL COUNTS
AX1. Ensure channel signals have groupId set.
AX2. Ensure group stats and monitored group counts use groupId not userId.
AX3. If channel is a source, include in counts.
AX4. Expose channel counts in "Monitored Channels" view.

SECTION AY: CURRENT VS ENTRY DISPLAY
AY1. For all analytics views, use entryMarketCap and currentMarketCap.
AY2. For live views, use batch price + supply to estimate current MC.
AY3. Use consistent formatting via UIHelper.

SECTION AZ: STRATEGY CREATION UI
AZ1. Add "Strategy" menu item in main menu.
AZ2. Add a simple wizard:
   - Step 1: Select target type (Group/User/Overall).
   - Step 2: Select timeframe (1D/7D/30D/ALL/Custom).
   - Step 3: Select filters (min MC, max MC, min volume).
   - Step 4: Select schedule (days, times, timezone).
   - Step 5: Select conditional gates (mentions/call count/volume).
   - Step 6: Show recommended strategies.
AZ3. Allow saving strategy presets.
AZ4. Provide "Activate strategy" toggle.
AZ5. Add "Explain Strategy" summary card before saving.
AZ6. Provide "Test on past 30D" simulation button.

SECTION BA: UI CLARITY IMPROVEMENTS
BA1. Avoid repeated use of "MCap View" on each card; make it a back button.
BA2. In distribution subviews, display "Target" and "Timeframe" in header.
BA3. For small screens, keep lines shorter than 60 characters.

SECTION BB: FUTURE IMPROVEMENTS
BB1. Add graphical mini charts for distributions.
BB2. Add per-group hourly heatmaps.
BB3. Add cross-group lag trend over time.
BB4. Add strategy calendar view (active windows heatmap).

SECTION BC: TECH DEBT CLEANUP
BC1. Remove duplicate logic in distribution building.
BC2. Centralize timeframe parsing and validation.
BC3. Centralize market cap formatting.

SECTION BD: METRICS QUALITY CHECKS
BD1. Ensure entryMarketCap is set for all signals.
BD2. Ensure sample marketCap is recorded at each sampling cycle.
BD3. Ensure athMarketCap is updated in metrics.

SECTION BE: PLANNED OUTPUTS
BE1. Updated distribution view with target selection and improved detail.
BE2. Enhanced analytics views with time-to-x metrics.
BE3. More accurate volume correlation analysis.
BE4. Robust rug analysis with time constraint.
BE5. Strategy menu on main menu.

SECTION BF: DOCUMENT HISTORY
BF1. 2026-01-14: Initial plan created from feedback.

END OF PLAN

