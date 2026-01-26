# Complete Commands Reference

This document provides a comprehensive reference for all Telegram bot commands.

---

## 📋 Table of Contents

- [Main Commands](#main-commands)
- [Group Management](#group-management)
- [Analytics Commands](#analytics-commands)
- [Copy Trading](#copy-trading)
- [Interactive Buttons](#interactive-buttons)
- [Command Examples](#command-examples)

---

## Main Commands

### `/menu`

Opens the main menu with all available options.

**Usage:**
```
/menu
```

**Response:**
Shows inline keyboard with:
- 🟢 Live Signals
- 🏆 Leaderboards
- 📊 Distributions
- 📈 Analytics
- 👥 Groups
- ⭐ Watchlist

---

### `/help`

Shows help information and setup guide.

**Usage:**
```
/help
```

**Response:**
Displays comprehensive help text with:
- Quick setup guide
- Common commands
- Troubleshooting tips

---

### `/ping`

Health check command. Verifies bot is responding.

**Usage:**
```
/ping
```

**Response:**
```
Pong!
```

---

## Group Management

### `/groups`

Lists all groups being monitored by the bot.

**Usage:**
```
/groups
```

**Response:**
Shows a list of all groups with:
- Group name
- Type (Source or Destination)
- Status (Active/Inactive)
- Group ID
- Signal count

**Example Output:**
```
📋 Monitored Groups

✅ My Trading Group
   Type: 📥 Source
   ID: -1001234567890
   Signals: 42

✅ My Destination Group
   Type: 📤 Destination
   ID: -1009876543210
   Signals: 0
```

**Buttons:**
- ➕ Add Group
- ⚙️ Settings

---

### `/setdestination`

Sets the current group as a destination for forwarded signals.

**Usage:**
```
/setdestination
```

Or specify a group ID:
```
/setdestination -1001234567890
```

**When to Use:**
- Run this in the group where you want signals forwarded
- Only one destination group is needed (but you can change it anytime)

**Response:**
```
✅ This group is now set as a destination for forwarded signals.
```

**Notes:**
- Bot must be a member of the group
- Group is automatically created if it doesn't exist
- Previous destination groups remain as source groups

---

### `/removegroup`

Removes a group from monitoring.

**Usage:**
```
/removegroup
```

Or specify a group ID:
```
/removegroup -1001234567890
```

**Response:**
```
✅ Group "Group Name" has been removed from monitoring.
```

**Notes:**
- If no group ID provided, uses current group
- Removes group from monitoring but doesn't delete historical data
- Cannot remove the destination group (set a new destination first)

---

### `/togglegroup`

Enables or disables monitoring for a group.

**Usage:**
```
/togglegroup
```

Or specify a group ID:
```
/togglegroup -1001234567890
```

**Response:**
```
✅ Group "Group Name" is now active.
```

or

```
✅ Group "Group Name" is now inactive.
```

**Use Cases:**
- Temporarily disable monitoring without removing group
- Re-enable a previously disabled group

---

## Analytics Commands

### `/analytics`

Opens the analytics dashboard.

**Usage:**
```
/analytics
```

**Response:**
Shows inline keyboard with:
- 👥 Groups
- 👤 Users
- 📈 Copy Trading
- 🎯 Strategies
- 📊 Performance

**Navigation:**
Click buttons to drill down into specific analytics.

---

### `/groupstats`

Shows detailed statistics for a group.

**Usage:**
```
/groupstats
```

Or specify a group ID:
```
/groupstats -1001234567890
```

**Response:**
Shows comprehensive group metrics:
- Total signals
- Hit rates (2x, 3x, 5x, 10x)
- Median ATH multiple
- Time to 2x
- Win rate
- Recent signals

**Metrics Explained:**
- **Hit Rate**: Percentage of signals that reached the threshold
- **Median ATH**: Middle value of all-time high multiples
- **Time to 2x**: Average time for signals to double in price
- **Win Rate**: Overall success percentage

**Example Output:**
```
📊 Group Statistics: My Trading Group

📈 Performance (30D)
Signals: 42
Win Rate: 71.4%

🎯 Hit Rates
2x: 66.7% (28 signals)
3x: 47.6% (20 signals)
5x: 28.6% (12 signals)
10x: 9.5% (4 signals)

📊 Metrics
Median ATH: 3.2x
P75 ATH: 5.1x
P90 ATH: 8.3x
Median Time to 2x: 2.5 hours
```

---

### `/userstats`

Shows detailed statistics for a user.

**Usage:**
```
/userstats <user_id>
```

**Example:**
```
/userstats 123456789
```

**Response:**
Shows user performance metrics:
- Total signals posted
- Hit rates
- Best/worst signals
- Consistency score
- Risk score

**Metrics Explained:**
- **Consistency Score**: How consistent the user's performance is (0-1)
- **Risk Score**: Volatility and drawdown metrics (0-1, lower is better)

**Example Output:**
```
👤 User Statistics: @username

📈 Performance (30D)
Signals: 15
Win Rate: 80.0%

🎯 Hit Rates
2x: 73.3% (11 signals)
3x: 60.0% (9 signals)
5x: 40.0% (6 signals)
10x: 13.3% (2 signals)

📊 Metrics
Median ATH: 4.5x
Consistency: 0.85 (High)
Risk Score: 0.32 (Low)
```

---

### `/groupleaderboard`

Shows group performance rankings.

**Usage:**
```
/groupleaderboard
```

Or specify time period:
```
/groupleaderboard 7D
/groupleaderboard 30D
/groupleaderboard ALL
```

**Response:**
Shows ranked list of groups by:
- Win rate
- Hit rates
- Median ATH
- Signal count

**Example Output:**
```
🏆 Group Leaderboard (30D)

1. 🥇 Elite Signals
   Win Rate: 85.7% | Signals: 28
   Median ATH: 4.2x

2. 🥈 Alpha Group
   Win Rate: 78.6% | Signals: 42
   Median ATH: 3.8x

3. 🥉 Trading Hub
   Win Rate: 71.4% | Signals: 35
   Median ATH: 3.2x
```

---

### `/userleaderboard`

Shows user performance rankings.

**Usage:**
```
/userleaderboard
```

Or specify time period:
```
/userleaderboard 7D
/userleaderboard 30D
/userleaderboard ALL
```

**Response:**
Shows ranked list of users by performance metrics.

**Example Output:**
```
👤 User Leaderboard (30D)

1. 🥇 @trader_pro
   Win Rate: 90.0% | Signals: 20
   Consistency: 0.92

2. 🥈 @alpha_caller
   Win Rate: 85.7% | Signals: 28
   Consistency: 0.88

3. 🥉 @signal_master
   Win Rate: 80.0% | Signals: 15
   Consistency: 0.85
```

---

## Copy Trading

### `/copytrade`

Shows top copy trading strategy recommendations.

**Usage:**
```
/copytrade
```

Or specify time period:
```
/copytrade 7D
/copytrade 30D
/copytrade ALL
```

**Response:**
Shows recommended strategies with:
- Strategy type (User or Group)
- Target ID
- Expected return
- Win rate
- Risk score
- Recommendation (STRONG_BUY, BUY, NEUTRAL, AVOID)

**Example Output:**
```
📈 Copy Trading Strategies (30D)

🥇 STRONG_BUY - Follow @trader_pro
   Expected Return: 245%
   Win Rate: 90.0%
   Risk: Low (0.25)
   Signals: 20

🥈 BUY - Follow Elite Signals Group
   Expected Return: 180%
   Win Rate: 85.7%
   Risk: Medium (0.45)
   Signals: 28

🥉 BUY - Follow @alpha_caller
   Expected Return: 165%
   Win Rate: 85.7%
   Risk: Medium (0.52)
   Signals: 28
```

---

### `/simulate`

Simulates following a user or group strategy.

**Usage:**
```
/simulate <type> <id> [capital]
```

**Parameters:**
- `type`: `user` or `group`
- `id`: User ID or Group ID
- `capital`: Starting capital (optional, default: 1000)

**Examples:**
```
# Simulate following a user with $1000
/simulate user 123456789 1000

# Simulate following a group with $5000
/simulate group -1001234567890 5000

# Use default $1000 capital
/simulate user 123456789
```

**Response:**
Shows hypothetical portfolio performance:
- Starting capital
- Final value
- Total return
- Number of trades
- Win rate
- Best trade
- Worst trade

**Example Output:**
```
💰 Simulation: Following @trader_pro

📊 Results (30D)
Starting Capital: $1,000.00
Final Value: $2,450.00
Total Return: +145.0%

📈 Performance
Trades: 20
Win Rate: 90.0%
Best Trade: +320% ($3,200)
Worst Trade: -15% ($850)

💡 This is a simulation based on historical data.
```

---

## Interactive Buttons

The bot uses inline keyboards for navigation. Here's what each button does:

### Signal Card Buttons

When a signal is detected, you'll see buttons:

- **📈 Chart**: View price chart for the token
- **📊 Stats**: View detailed signal statistics
- **⭐ Watchlist**: Add to watchlist (coming soon)

### Menu Buttons

From `/menu` or `/analytics`:

- **🟢 Live Signals**: View active signals
- **🏆 Leaderboards**: View rankings
- **📊 Distributions**: View performance distributions
- **📈 Analytics**: Open analytics dashboard
- **👥 Groups**: Manage groups
- **⭐ Watchlist**: View watchlist

### Analytics Buttons

- **👥 Groups**: Group analytics
- **👤 Users**: User analytics
- **📈 Copy Trading**: Strategy recommendations
- **🎯 Strategies**: Detailed strategies
- **📊 Performance**: Overall performance

---

## Command Examples

### Complete Setup Workflow

```bash
# 1. Set destination group
/setdestination

# 2. Verify groups
/groups

# 3. Check analytics
/analytics

# 4. View group stats
/groupstats

# 5. View leaderboard
/groupleaderboard 30D
```

### Daily Monitoring

```bash
# Morning check
/analytics
/groupleaderboard 7D
/userleaderboard 7D

# Check specific group
/groupstats -1001234567890

# Check copy trading opportunities
/copytrade 30D
```

### Research Workflow

```bash
# Find top performers
/userleaderboard ALL
/groupleaderboard ALL

# Analyze specific user
/userstats 123456789

# Simulate following
/simulate user 123456789 1000
/simulate group -1001234567890 5000
```

---

## Tips & Best Practices

1. **Use Time Periods**: Always specify time periods for leaderboards (7D, 30D, ALL)
2. **Check Multiple Metrics**: Don't rely on just win rate - check ATH, consistency, risk
3. **Regular Monitoring**: Check analytics daily to spot trends
4. **Compare Strategies**: Use `/simulate` to compare different users/groups
5. **Group Management**: Regularly review `/groups` to ensure all groups are active

---

## Troubleshooting Commands

If a command doesn't work:

1. Check bot is online: `/ping`
2. Verify groups: `/groups`
3. Check bot logs for errors
4. Ensure you're using the command in the right context (some commands need to be in groups)

---

**Last Updated**: January 2025
















