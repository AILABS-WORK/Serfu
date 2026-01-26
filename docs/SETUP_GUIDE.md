# Complete Setup Guide

This guide will walk you through setting up the AlphaColor Signal Analytics Bot from scratch.

## Prerequisites Checklist

Before starting, ensure you have:

- [ ] Node.js v18+ installed
- [ ] PostgreSQL database (local or cloud)
- [ ] Redis server (local or cloud)
- [ ] Telegram account
- [ ] Helius account (for API key)

---

## Step 1: Create Telegram Bot

### 1.1 Get Bot Token

1. Open Telegram and search for **@BotFather**
2. Send `/newbot` command
3. Follow prompts:
   - Choose a name: `AlphaColor Analytics Bot`
   - Choose a username: `your_bot_username_bot`
4. **Copy the bot token** (looks like: `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)
5. Save it securely - you'll need it for `.env`

### 1.2 Configure Bot Privacy (CRITICAL)

**This step is essential** - without it, the bot cannot read group messages:

1. In BotFather, send `/setprivacy`
2. Select your bot from the list
3. Choose **Disable** (bot will read all messages)
4. BotFather will confirm: "Success! The bot will now receive all messages in groups."

### 1.3 (Optional) Set Bot Description

1. Send `/setdescription` to BotFather
2. Select your bot
3. Add description: "Monitors Solana signals and provides analytics"

---

## Step 2: Get Helius API Key

1. Go to [Helius Dashboard](https://dashboard.helius.dev)
2. Sign up or log in
3. Create a new API key
4. Copy the API key
5. Save it for `.env` file

**Note**: Free tier is sufficient for development. For production, consider a paid plan.

---

## Step 3: Set Up Database

### Option A: Local PostgreSQL

```bash
# Install PostgreSQL (if not installed)
# macOS: brew install postgresql
# Ubuntu: sudo apt-get install postgresql
# Windows: Download from postgresql.org

# Start PostgreSQL service
# macOS: brew services start postgresql
# Ubuntu: sudo systemctl start postgresql

# Create database
createdb serfu

# Or using psql:
psql -U postgres
CREATE DATABASE serfu;
\q
```

### Option B: Cloud PostgreSQL (Railway, Supabase, etc.)

1. Create a PostgreSQL database in your cloud provider
2. Copy the connection string
3. It will look like: `postgresql://user:password@host:port/database`

---

## Step 4: Set Up Redis

### Option A: Local Redis

```bash
# Install Redis
# macOS: brew install redis
# Ubuntu: sudo apt-get install redis-server
# Windows: Download from redis.io

# Start Redis
# macOS: brew services start redis
# Ubuntu: sudo systemctl start redis
```

### Option B: Cloud Redis (Railway, Upstash, etc.)

1. Create a Redis instance in your cloud provider
2. Copy the connection URL
3. It will look like: `redis://user:password@host:port`

---

## Step 5: Clone and Install

```bash
# Clone repository
git clone <repository-url>
cd Serfu

# Install dependencies
npm install

# This will install:
# - TypeScript and build tools
# - Telegraf (Telegram bot framework)
# - Prisma (ORM)
# - Helius SDK
# - BullMQ (job queue)
# - And more...
```

---

## Step 6: Configure Environment

```bash
# Copy template
cp env.sample .env

# Edit .env file
# Use your preferred editor (nano, vim, VS Code, etc.)
```

Edit `.env` with your values:

```env
# Telegram Bot Token (from Step 1)
BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrsTUVwxyz

# Database URL (from Step 3)
DATABASE_URL=postgresql://user:password@localhost:5432/serfu

# Redis URL (from Step 4)
REDIS_URL=redis://localhost:6379

# Helius API Key (from Step 2)
HELIUS_API_KEY=your_helius_api_key_here

# Optional
NODE_ENV=development
```

**Security Note**: Never commit `.env` to git. It's already in `.gitignore`.

---

## Step 7: Initialize Database

```bash
# Generate Prisma client
npx prisma generate

# Run migrations (creates all tables)
npx prisma migrate dev

# You'll be prompted to name the migration
# Enter: "initial_setup" or similar

# (Optional) Open Prisma Studio to verify
npx prisma studio
# Opens at http://localhost:5555
```

---

## Step 8: Test Configuration

```bash
# Test environment variables
npm run check-env

# Test Helius connection
npm run test-provider

# Both should succeed without errors
```

---

## Step 9: Start the Bot

```bash
# Development mode (with auto-reload)
npm run dev

# You should see:
# info: Connected to Redis
# info: Connected to Postgres
# info: Bot launched!
```

**Keep this terminal open** - the bot needs to run continuously.

---

## Step 10: Configure Telegram Groups

### 10.1 Set Destination Group

1. Create or select a Telegram group where you want signals forwarded
2. Add your bot to the group
3. **Promote bot to admin** (recommended):
   - Group Settings → Administrators → Add Administrator
   - Select your bot
   - Grant necessary permissions
4. In the group, send: `/setdestination`
5. Bot should reply: "✅ This group is now set as a destination for forwarded signals."

### 10.2 Add Source Groups

1. Add bot to any Telegram groups you want to monitor
2. Bot will **automatically** start tracking
3. No command needed - just add the bot!

### 10.3 Verify Groups

In any group or DM with the bot, send:
```
/groups
```

You should see:
- Your destination group (marked as 📤 Destination)
- All source groups (marked as 📥 Source)
- Status (✅ Active or ❌ Inactive)

---

## Step 11: Test Signal Detection

1. In one of your source groups, post a test signal:
   ```
   🚀 Signal Alert!
   
   Token: Shitcoin (SHIT)
   Mint: G2dJVAF27n4xBGjftmrpTydiUGb5eCjferW3KDRubonk
   MC: $100K
   ```

2. Bot should:
   - Detect the signal
   - Fetch token metadata from Helius
   - Forward to destination group
   - Send a signal card with buttons

3. Check destination group - you should see the forwarded signal!

---

## Step 12: Verify Analytics

```bash
# In Telegram, try these commands:

# Main menu
/menu

# Analytics dashboard
/analytics

# Group stats
/groupstats

# User leaderboard
/userleaderboard 30D
```

---

## Troubleshooting

### Bot Not Reading Messages

**Problem**: Bot doesn't detect signals in groups

**Solutions**:
1. Verify bot privacy is OFF (Step 1.2)
2. Check bot is admin in the group
3. Ensure bot is actually in the group
4. Check bot logs for errors

### Database Connection Errors

**Problem**: `Can't reach database server`

**Solutions**:
1. Verify PostgreSQL is running: `pg_isready`
2. Check `DATABASE_URL` in `.env` is correct
3. Test connection: `psql $DATABASE_URL`
4. Check firewall/network settings

### Redis Connection Errors

**Problem**: `Error connecting to Redis`

**Solutions**:
1. Verify Redis is running: `redis-cli ping` (should return PONG)
2. Check `REDIS_URL` in `.env` is correct
3. Test connection: `redis-cli -u $REDIS_URL ping`

### Helius API Errors

**Problem**: `401 Unauthorized` or price fetch fails

**Solutions**:
1. Verify `HELIUS_API_KEY` is correct in `.env`
2. Check API key is active in Helius dashboard
3. Test with: `npm run test-provider`
4. Ensure API key has necessary permissions

### Signals Not Forwarding

**Problem**: Signals detected but not forwarded

**Solutions**:
1. Verify destination group is set: `/groups`
2. Check bot is in destination group
3. Check bot logs for forwarding errors
4. Verify destination group is active (not toggled off)

---

## Next Steps

Once setup is complete:

1. **Monitor Performance**: Check `/analytics` regularly
2. **Review Leaderboards**: See top performers with `/groupleaderboard`
3. **Explore Copy Trading**: Try `/copytrade` for strategy recommendations
4. **Customize**: Adjust settings as needed

---

## Production Deployment

For production deployment, see [Deployment Guide](./DEPLOYMENT.md) or the main [README.md](../README.md#-deployment).

---

**Need Help?** Check the main [README.md](../README.md) or review logs with `npm run dev`.
















