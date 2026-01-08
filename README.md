# AlphaColor Signal Analytics Bot

A production-grade Telegram bot for monitoring Solana token signals across multiple Telegram groups, tracking performance via Helius, and providing comprehensive analytics with copy trading insights.

## 📋 Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Quick Start](#quick-start)
- [Complete Setup Guide](#complete-setup-guide)
- [Telegram Bot Commands](#telegram-bot-commands)
- [User Guide](#user-guide)
- [Architecture](#architecture)
- [Development](#development)
- [Deployment](#deployment)

---

## 🎯 Overview

The AlphaColor Signal Analytics Bot is designed to:

- **Monitor Multiple Groups**: Automatically track signals from multiple Telegram groups
- **Forward Signals**: Forward detected signals to your destination group
- **Track Performance**: Monitor token prices over time with adaptive sampling
- **Provide Analytics**: Deep insights into group and user performance
- **Copy Trading Insights**: Recommendations on which users/groups to follow

### What It Does

1. **Ingests** all messages from configured Telegram groups
2. **Detects** Solana token signals (mint addresses)
3. **Tracks** price performance over time using Helius API
4. **Forwards** signals to your destination group
5. **Analyzes** performance metrics for groups and users
6. **Recommends** copy trading strategies based on historical data

### What It Doesn't Do

- ❌ Execute trades (no wallet integration)
- ❌ Provide financial advice
- ❌ Support multi-chain (Solana only in v1)

---

## ✨ Features

### Core Features

- ✅ **Multi-Group Monitoring**: Track signals from unlimited Telegram groups
- ✅ **Signal Forwarding**: Automatically forward signals to destination groups
- ✅ **Price Tracking**: Real-time price monitoring with adaptive sampling
- ✅ **Threshold Detection**: Automatic alerts for 2x, 3x, 5x, 10x milestones
- ✅ **Group Analytics**: Performance metrics per group
- ✅ **User Analytics**: Performance tracking per user
- ✅ **Copy Trading**: Strategy recommendations and simulations
- ✅ **Interactive Charts**: Visual price charts with entry/ATH markers
- ✅ **Leaderboards**: Group and user performance rankings

### Data Sources

- **Helius SDK**: Primary data provider for Solana token prices and metadata
- **PostgreSQL**: Persistent storage for all signals, prices, and metrics
- **Redis**: Job queue for price sampling and aggregation

---

## 🚀 Quick Start

### Prerequisites

- Node.js v18+ (v22.21.1 recommended)
- PostgreSQL database
- Redis server
- Telegram Bot Token (from [@BotFather](https://t.me/BotFather))
- Helius API Key (from [Helius Dashboard](https://dashboard.helius.dev))

### Installation

```bash
# Clone the repository
git clone <repository-url>
cd Serfu

# Install dependencies
npm install

# Copy environment variables template
cp env.sample .env

# Edit .env with your credentials
# Required: BOT_TOKEN, DATABASE_URL, REDIS_URL, HELIUS_API_KEY

# Generate Prisma client
npx prisma generate

# Run database migrations
npx prisma migrate dev

# Start the bot
npm run dev
```

---

## 📖 Complete Setup Guide

### Step 1: Create Telegram Bot

1. Open Telegram and search for [@BotFather](https://t.me/BotFather)
2. Send `/newbot` command
3. Follow the prompts to name your bot
4. Copy the bot token (format: `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)
5. **Important**: Set bot privacy to **OFF**:
   ```
   /setprivacy
   Select your bot
   Disable
   ```
   This allows the bot to read all messages in groups.

### Step 2: Configure Environment Variables

Create a `.env` file with the following:

```env
# Telegram Bot
BOT_TOKEN=your_bot_token_here

# Database (PostgreSQL)
DATABASE_URL=postgresql://user:password@localhost:5432/serfu

# Redis (for job queue)
REDIS_URL=redis://localhost:6379

# Helius API (Solana data)
HELIUS_API_KEY=your_helius_api_key_here

# Optional: Node Environment
NODE_ENV=production
```

### Step 3: Set Up Database

```bash
# Generate Prisma client
npx prisma generate

# Create database schema
npx prisma migrate dev

# (Optional) Open Prisma Studio to view data
npx prisma studio
```

### Step 4: Add Bot to Your Destination Group

1. Create or open your destination Telegram group (where you want signals forwarded)
2. Add the bot as a member
3. **Promote bot to admin** (recommended for better reliability)
4. In the group, send: `/setdestination`
5. Bot will confirm: "✅ This group is now set as a destination for forwarded signals."

### Step 5: Add Bot to Source Groups

1. Add the bot to any Telegram group you want to monitor
2. The bot will **automatically** start tracking the group
3. No additional setup needed - the bot auto-detects new groups

### Step 6: Verify Setup

```bash
# Check bot is running
npm run dev

# In Telegram, send to your bot:
/menu
/groups
```

---

## 💬 Telegram Bot Commands

### Main Commands

| Command | Description | Usage |
|---------|-------------|-------|
| `/menu` | Open main menu with all options | `/menu` |
| `/help` | Show help and setup guide | `/help` |
| `/ping` | Health check | `/ping` |

### Group Management

| Command | Description | Usage |
|---------|-------------|-------|
| `/groups` | List all monitored groups | `/groups` |
| `/setdestination` | Set current group as destination | `/setdestination` or `/setdestination <group_id>` |
| `/removegroup` | Remove a group from monitoring | `/removegroup <group_id>` |
| `/togglegroup` | Enable/disable group monitoring | `/togglegroup <group_id>` |

### Analytics Commands

| Command | Description | Usage |
|---------|-------------|-------|
| `/analytics` | Open analytics dashboard | `/analytics` |
| `/groupstats` | View group performance stats | `/groupstats` or `/groupstats <group_id>` |
| `/userstats` | View user performance stats | `/userstats <user_id>` |
| `/groupleaderboard` | Group performance ranking | `/groupleaderboard [7D\|30D\|ALL]` |
| `/userleaderboard` | User performance ranking | `/userleaderboard [7D\|30D\|ALL]` |

### Copy Trading

| Command | Description | Usage |
|---------|-------------|-------|
| `/copytrade` | View top copy trading strategies | `/copytrade [7D\|30D\|ALL]` |
| `/simulate` | Simulate following a user/group | `/simulate user <user_id> [capital]` or `/simulate group <group_id> [capital]` |

### Examples

```bash
# Set current group as destination
/setdestination

# View group stats for current group
/groupstats

# View user stats
/userstats 123456789

# View 7-day group leaderboard
/groupleaderboard 7D

# Simulate following a user with $1000 capital
/simulate user 123456789 1000
```

---

## 📱 User Guide

### Initial Setup

1. **Add Bot to Destination Group**
   - Create or select your destination group
   - Add bot as member and promote to admin
   - Run `/setdestination` in the group

2. **Add Bot to Source Groups**
   - Add bot to any groups you want to monitor
   - Bot automatically starts tracking

3. **Verify Groups**
   - Run `/groups` to see all monitored groups
   - Check that your destination group shows as "📤 Destination"

### How Signal Forwarding Works

1. Bot monitors all configured source groups
2. When a signal is detected (Solana mint address found):
   - Bot fetches token metadata and entry price from Helius
   - Bot creates a signal record
   - Bot forwards the signal to all destination groups
3. Signal notifications include:
   - Token name/symbol
   - Mint address (copyable)
   - Entry price
   - Source group information
   - Interactive buttons (Chart, Stats, Watchlist)

### Understanding Analytics

#### Group Metrics

- **Signal Count**: Total signals from this group
- **Hit Rates**: Percentage of signals that hit 2x, 3x, 5x, 10x
- **Median ATH**: Median all-time high multiple
- **Time to 2x**: Average time for signals to reach 2x
- **Win Rate**: Overall success rate

#### User Metrics

- **Signal Count**: Total signals posted by user
- **Hit Rates**: Performance at different thresholds
- **Consistency Score**: How consistent the user's performance is
- **Risk Score**: Volatility and drawdown metrics

#### Copy Trading Strategies

The bot analyzes historical performance and recommends:
- **STRONG_BUY**: High win rate, consistent returns, low risk
- **BUY**: Good performance with acceptable risk
- **NEUTRAL**: Mixed performance
- **AVOID**: Poor performance or high risk

### Interactive Features

#### Signal Cards

When a signal is detected, you'll see a card with:
- Token information
- Entry price
- Source group
- Buttons:
  - 📈 **Chart**: View price chart
  - 📊 **Stats**: Detailed statistics
  - ⭐ **Watchlist**: Add to watchlist (coming soon)

#### Analytics Dashboard

Access via `/analytics` or from main menu:
- **Groups**: View all groups and their performance
- **Users**: View top users and their stats
- **Copy Trading**: Strategy recommendations
- **Performance**: Overall performance metrics

#### Leaderboards

- **Group Leaderboard**: Ranked by win rate, hit rates, or ATH
- **User Leaderboard**: Ranked by user performance
- Filter by time period: 7D, 30D, or ALL

---

## 🏗️ Architecture

### System Components

```
┌─────────────────┐
│  Telegram Bot   │
│   (Telegraf)    │
└────────┬────────┘
         │
         ├──► Message Ingestion ──► RawMessage (DB)
         │
         ├──► Signal Detection ──► Signal (DB)
         │
         ├──► Signal Forwarding ──► ForwardedSignal (DB)
         │
         └──► User Commands ──► Analytics/Management
                  │
                  ▼
         ┌─────────────────┐
         │  Job Scheduler  │
         │    (BullMQ)     │
         └────────┬────────┘
                  │
                  ├──► Price Sampling ──► PriceSample (DB)
                  │
                  └──► Aggregation ──► Metrics (DB)
                           │
                           ▼
                  ┌─────────────────┐
                  │  Helius API     │
                  │  (Price Data)   │
                  └─────────────────┘
```

### Database Schema

#### Core Tables

- **raw_messages**: All Telegram messages (for auditing)
- **signals**: Detected token signals
- **price_samples**: Historical price data
- **threshold_events**: 2x/3x/5x/10x milestone hits
- **signal_metrics**: Per-signal analytics

#### Group & User Tables

- **groups**: Telegram groups being monitored
- **users**: Telegram users who post signals
- **group_metrics**: Aggregated group performance
- **user_metrics**: Aggregated user performance

#### Analytics Tables

- **forwarded_signals**: Signal forwarding history
- **copy_trading_strategies**: Strategy recommendations
- **category_metrics**: Category-level aggregations

### Data Flow

1. **Message Ingestion**
   - Telegram message received
   - Stored in `raw_messages`
   - Group and user auto-tracked

2. **Signal Detection**
   - Parser extracts Solana mint address
   - Signal created in `signals` table
   - Entry price fetched from Helius

3. **Signal Forwarding**
   - Signal forwarded to destination groups
   - Recorded in `forwarded_signals`

4. **Price Tracking**
   - Job scheduler samples prices
   - Adaptive intervals based on signal age
   - Threshold events detected and stored

5. **Analytics**
   - Aggregation jobs compute metrics
   - Group and user metrics updated
   - Copy trading strategies generated

### Technology Stack

- **Runtime**: Node.js v22+
- **Language**: TypeScript
- **Framework**: Telegraf (Telegram Bot)
- **Database**: PostgreSQL with Prisma ORM
- **Job Queue**: BullMQ with Redis
- **Data Provider**: Helius SDK
- **Charts**: Chart.js with node-canvas

---

## 🛠️ Development

### Project Structure

```
serfu/
├── src/
│   ├── bot/              # Telegram bot logic
│   │   ├── commands/      # Bot commands
│   │   ├── actions.ts     # Callback handlers
│   │   ├── middleware.ts  # Message ingestion
│   │   └── forwarder.ts  # Signal forwarding
│   ├── db/               # Database repositories
│   ├── providers/        # Data providers (Helius)
│   ├── ingest/           # Signal detection/parsing
│   ├── jobs/             # Background jobs
│   ├── analytics/         # Analytics computation
│   └── charts/            # Chart rendering
├── prisma/
│   └── schema.prisma     # Database schema
├── scripts/              # Utility scripts
└── tests/                # Test files
```

### Available Scripts

```bash
# Development
npm run dev          # Start with nodemon (auto-reload)

# Build
npm run build        # Compile TypeScript

# Production
npm start            # Start compiled bot

# Database
npx prisma studio    # Open database GUI
npx prisma migrate   # Run migrations
npx prisma generate  # Generate Prisma client

# Testing
npm test             # Run tests
```

### Environment Variables

See `env.sample` for all available variables.

**Required:**
- `BOT_TOKEN`: Telegram bot token
- `DATABASE_URL`: PostgreSQL connection string
- `REDIS_URL`: Redis connection string
- `HELIUS_API_KEY`: Helius API key

**Optional:**
- `NODE_ENV`: Environment (development/production)
- `LOG_LEVEL`: Logging level (info/debug/error)

### Adding New Features

1. **New Command**: Add to `src/bot/commands/`
2. **New Database Model**: Update `prisma/schema.prisma`, run migration
3. **New Job**: Add to `src/jobs/`, register in scheduler
4. **New Provider**: Implement interface in `src/providers/`

### Testing

```bash
# Run tests
npm test

# Run specific test file
npm test -- tests/parser.test.ts

# Watch mode
npm test -- --watch
```

---

## 🚢 Deployment

### Railway Deployment

1. **Connect Repository**
   - Link your GitHub repository to Railway
   - Railway will auto-detect Node.js project

2. **Set Environment Variables**
   - Go to Railway project settings
   - Add all required environment variables:
     - `BOT_TOKEN`
     - `DATABASE_URL` (Railway PostgreSQL)
     - `REDIS_URL` (Railway Redis)
     - `HELIUS_API_KEY`

3. **Deploy**
   - Railway will automatically build and deploy
   - Check logs for any errors

4. **Run Migrations**
   - After first deployment, run:
   ```bash
   npx prisma migrate deploy
   ```
   Or add to build script:
   ```json
   "build": "prisma generate && tsc",
   "start": "prisma migrate deploy && node dist/index.js"
   ```

### Docker Deployment

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
RUN npm run build
CMD ["npm", "start"]
```

### Health Checks

The bot responds to `/ping` for health checks. Use this for monitoring.

---

## 📚 Additional Documentation

- [PRD.txt](./PRD.txt) - Product Requirements Document
- [STATUS_AND_ROADMAP.md](./STATUS_AND_ROADMAP.md) - Implementation status
- [BUILD_PLAN.md](./BUILD_PLAN.md) - Development phases
- [QA_WALKTHROUGH.md](./QA_WALKTHROUGH.md) - Testing guide

---

## ❓ Help & Support

### Common Issues

**Bot not reading messages:**
- Ensure bot privacy is set to OFF in BotFather
- Promote bot to admin in the group

**Signals not forwarding:**
- Check that destination group is set: `/groups`
- Verify bot is added to destination group
- Check bot logs for errors

**Price data not updating:**
- Verify Helius API key is valid
- Check Redis connection
- Review job scheduler logs

### Getting Help

1. Check this README first
2. Review logs: `npm run dev` shows detailed logs
3. Check database: `npx prisma studio`
4. Verify environment variables are set correctly

---

## 📝 License

[Add your license here]

---

## 🙏 Acknowledgments

- Built with [Telegraf](https://telegraf.js.org/)
- Data provided by [Helius](https://helius.dev/)
- Powered by [Prisma](https://www.prisma.io/)

---

**Last Updated**: January 2025
