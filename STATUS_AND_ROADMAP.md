# AlphaColor Bot - Current Status & Roadmap

## ✅ What's Been Completed

### Core Infrastructure (Phase 0-2)
- ✅ Project structure initialized
- ✅ TypeScript, ESLint, Prettier configured
- ✅ Environment variables with dotenv
- ✅ Winston logging
- ✅ README.md created

### Database (Phase 1)
- ✅ Prisma schema with all core tables:
  - `raw_messages` - stores all messages
  - `signals` - tracks detected signals
  - `price_samples` - price history
  - `threshold_events` - 2x/3x/5x/10x hits
  - `signal_metrics` - per-signal analytics
  - `category_metrics` - aggregated category stats
- ✅ Migrations created
- ✅ DB repository layer implemented

### Helius Provider (Phase 2)
- ✅ Helius SDK integrated (100% Helius-only)
- ✅ `getQuote()` - price fetching via `getAsset().token_info.price_info`
- ✅ `getTokenMeta()` - metadata via `getAsset()`
- ✅ Tested and working with real tokens

### Telegram Bot (Phase 3-4)
- ✅ Telegraf bot setup
- ✅ Message ingestion middleware (stores all messages)
- ✅ Signal detection (mint extraction + keyword matching)
- ✅ Signal creation with entry price fetch
- ✅ Basic `/menu` command
- ✅ Signal notifications

### Price Sampling (Phase 5)
- ✅ Dynamic sampling scheduler (age-based intervals)
- ✅ Price sampling job (runs every minute)
- ✅ Threshold detection (2x, 3x, 4x, 5x, 10x)
- ✅ Signal metrics updates (ATH, drawdown, multiples)

### Aggregation (Phase 6)
- ✅ Aggregation jobs (hourly/daily)
- ✅ Category metrics computation
- ⚠️ Basic leaderboard structure (needs UI)

### Charts (Phase 7)
- ✅ Chart rendering with node-canvas
- ✅ Line charts with entry price overlay
- ⚠️ Basic implementation (needs timeframe switching)

---

## ❌ What's Missing / Not Working

### Critical Missing Features

#### 1. Multi-Group Support
- ❌ Bot can only listen to ONE group (where it's added)
- ❌ No group management system
- ❌ No way to configure which groups to monitor
- ❌ No group metadata tracking (group name, type, etc.)

#### 2. Signal Forwarding
- ❌ No ability to forward signals to destination groups
- ❌ No user-configurable forwarding rules
- ❌ No filtering/selection logic for which signals to forward

#### 3. Group-Level Analytics
- ❌ No `Group` model in database
- ❌ No group performance metrics
- ❌ No group comparison views
- ❌ No "best performing groups" leaderboard

#### 4. User-Level Analytics
- ❌ No `User` model in database
- ❌ No user performance tracking
- ❌ No user signal history
- ❌ No "best performing users" leaderboard
- ❌ No user reputation/score system

#### 5. Advanced Analytics & Strategy
- ❌ No copy trading strategy recommendations
- ❌ No "follow this user/group" insights
- ❌ No win rate analysis by user/group
- ❌ No risk/reward analysis
- ❌ No time-to-profit analysis
- ❌ No drill-down analytics UI

#### 6. UI/UX Enhancements
- ❌ No pagination utility implemented
- ❌ No `/leaderboard` command UI
- ❌ No `/distributions` command UI
- ❌ No group selection interface
- ❌ No user selection interface
- ❌ No analytics dashboard

#### 7. Admin Features
- ❌ No admin middleware
- ❌ No settings menu
- ❌ No group management commands

---

## 🚀 New Features Required (Your Request)

### Feature Set 1: Multi-Group Monitoring
**Goal:** Bot listens to multiple groups and tracks signals by source group

**Requirements:**
1. Add bot to multiple Telegram groups
2. Track which group each signal came from
3. Store group metadata (name, ID, type)
4. Allow user to configure which groups to monitor
5. Show group name in signal cards

### Feature Set 2: Signal Forwarding
**Goal:** Forward signals from monitored groups to user's destination group

**Requirements:**
1. User selects a "destination group" for forwarded signals
2. Bot forwards detected signals to destination group
3. Filtering options (by group, by user, by confidence)
4. Customizable forwarding format
5. Track forwarding history

### Feature Set 3: Group Analytics
**Goal:** Deep analytics on group performance

**Requirements:**
1. Group performance metrics:
   - Total signals
   - Win rate (2x/3x/5x/10x hit rates)
   - Average ATH multiple
   - Median time to 2x
   - Best performing signals
2. Group comparison view
3. Group leaderboard
4. Clickable group cards → detailed analytics

### Feature Set 4: User Analytics
**Goal:** Track and analyze individual user performance

**Requirements:**
1. User performance metrics:
   - Total signals posted
   - Win rate
   - Average ATH multiple
   - Best/worst signals
   - Signal frequency
2. User leaderboard
3. User profile view
4. Clickable user cards → detailed analytics

### Feature Set 5: Copy Trading Strategy
**Goal:** Recommend best users/groups to follow for copy trading

**Requirements:**
1. Strategy recommendations:
   - "Best users to copy trade"
   - "Best groups to follow"
   - Risk-adjusted returns
   - Consistency scores
2. Copy trading insights:
   - "If you copied User X, you would have made..."
   - "Group Y has 85% win rate in last 30 days"
   - "User Z's signals average 3.2x in 24h"
3. Strategy comparison:
   - Compare following different users/groups
   - Show hypothetical portfolio performance

### Feature Set 6: Advanced Analytics UI
**Goal:** Interactive analytics dashboard in Telegram

**Requirements:**
1. Main analytics menu:
   - Groups Overview
   - Users Overview
   - Copy Trading Insights
   - Strategy Recommendations
2. Drill-down views:
   - Click group → see all signals from that group
   - Click user → see all signals from that user
   - Click signal → see full analytics
3. Filters:
   - Time period (7D, 30D, ALL)
   - Group filter
   - User filter
   - Performance filter (win rate, ATH, etc.)

---

## 📋 Implementation Plan

### Phase 11: Database Schema Extensions

**New Models Needed:**

```prisma
model Group {
  id              Int      @id @default(autoincrement())
  chatId          BigInt   @unique @map("chat_id")
  name            String?
  type            String?  // "source" or "destination"
  isActive        Boolean  @default(true) @map("is_active")
  createdAt       DateTime @default(now()) @map("created_at")
  updatedAt       DateTime @updatedAt @map("updated_at")
  
  // Relations
  signals         Signal[]
  rawMessages     RawMessage[]
  groupMetrics    GroupMetric[]
  
  @@map("groups")
}

model User {
  id              Int      @id @default(autoincrement())
  userId          BigInt   @unique @map("user_id")
  username        String?
  firstName       String?  @map("first_name")
  lastName        String?  @map("last_name")
  createdAt       DateTime @default(now()) @map("created_at")
  updatedAt       DateTime @updatedAt @map("updated_at")
  
  // Relations
  signals         Signal[]
  rawMessages     RawMessage[]
  userMetrics     UserMetric[]
  
  @@map("users")
}

model GroupMetric {
  id              Int      @id @default(autoincrement())
  groupId         Int      @map("group_id")
  window          String   // 7D, 30D, ALL
  signalCount     Int      @map("signal_count")
  hit2Rate        Float    @map("hit2_rate")
  hit3Rate        Float    @map("hit3_rate")
  hit5Rate        Float    @map("hit5_rate")
  hit10Rate       Float    @map("hit10_rate")
  medianAth       Float    @map("median_ath")
  p75Ath          Float    @map("p75_ath")
  p90Ath          Float    @map("p90_ath")
  medianDrawdown  Float    @map("median_drawdown")
  medianTimeTo2x  Float?   @map("median_time_to_2x")
  avgWinRate      Float    @map("avg_win_rate")
  totalSignals    Int      @map("total_signals")
  updatedAt       DateTime @default(now()) @map("updated_at")
  
  group           Group    @relation(fields: [groupId], references: [id])
  
  @@unique([groupId, window])
  @@map("group_metrics")
}

model UserMetric {
  id              Int      @id @default(autoincrement())
  userId          Int      @map("user_id")
  window          String   // 7D, 30D, ALL
  signalCount     Int      @map("signal_count")
  hit2Rate        Float    @map("hit2_rate")
  hit3Rate        Float    @map("hit3_rate")
  hit5Rate        Float    @map("hit5_rate")
  hit10Rate       Float    @map("hit10_rate")
  medianAth       Float    @map("median_ath")
  p75Ath          Float    @map("p75_ath")
  p90Ath          Float    @map("p90_ath")
  medianDrawdown  Float    @map("median_drawdown")
  medianTimeTo2x  Float?   @map("median_time_to_2x")
  avgWinRate      Float    @map("avg_win_rate")
  totalSignals    Int      @map("total_signals")
  consistencyScore Float?  @map("consistency_score") // 0-1
  riskScore       Float?   @map("risk_score") // 0-1
  updatedAt       DateTime @default(now()) @map("updated_at")
  
  user            User     @relation(fields: [userId], references: [id])
  
  @@unique([userId, window])
  @@map("user_metrics")
}

model ForwardedSignal {
  id              Int      @id @default(autoincrement())
  signalId        Int      @map("signal_id")
  sourceGroupId   BigInt   @map("source_group_id")
  destGroupId     BigInt   @map("dest_group_id")
  forwardedAt     DateTime @default(now()) @map("forwarded_at")
  forwardedBy     BigInt?  @map("forwarded_by") // User who configured forwarding
  
  signal          Signal   @relation(fields: [signalId], references: [id])
  
  @@unique([signalId, destGroupId])
  @@map("forwarded_signals")
}

model CopyTradingStrategy {
  id              Int      @id @default(autoincrement())
  strategyType    String   @map("strategy_type") // "user" or "group"
  targetId        Int      @map("target_id") // User ID or Group ID
  window          String   // 7D, 30D, ALL
  expectedReturn  Float    @map("expected_return")
  winRate         Float    @map("win_rate")
  riskScore       Float    @map("risk_score")
  consistencyScore Float   @map("consistency_score")
  recommendation  String   // "STRONG_BUY", "BUY", "NEUTRAL", "AVOID"
  updatedAt       DateTime @default(now()) @map("updated_at")
  
  @@unique([strategyType, targetId, window])
  @@map("copy_trading_strategies")
}
```

**Schema Updates:**
- Add `groupId` to `Signal` model
- Add `userId` to `Signal` model (from sender)
- Add `groupId` to `RawMessage` model
- Add indexes for performance

### Phase 12: Group Management

**Commands:**
- `/groups` - List all monitored groups
- `/addgroup` - Add a group to monitor
- `/removegroup` - Remove a group
- `/setdestination <group_id>` - Set destination group for forwarding

**Features:**
- Auto-detect group when bot is added
- Store group metadata
- Group activation/deactivation

### Phase 13: Signal Forwarding

**Features:**
- Forward signals to destination group
- Filtering rules (by group, user, confidence)
- Custom message formatting
- Forwarding history tracking

### Phase 14: Group Analytics

**Commands:**
- `/groupstats <group_id>` - View group analytics
- `/groupleaderboard` - Group performance ranking
- `/groupcompare` - Compare multiple groups

**Metrics:**
- Compute group-level aggregations
- Update group metrics table
- Display in interactive UI

### Phase 15: User Analytics

**Commands:**
- `/userstats <user_id>` - View user analytics
- `/userleaderboard` - User performance ranking
- `/usercompare` - Compare multiple users

**Metrics:**
- Compute user-level aggregations
- Update user metrics table
- Display in interactive UI

### Phase 16: Copy Trading Strategy Engine

**Features:**
- Compute strategy recommendations
- Risk-adjusted scoring
- Consistency analysis
- Hypothetical portfolio simulation
- Strategy comparison tool

**Commands:**
- `/strategies` - View recommended strategies
- `/copytrade <user_id|group_id>` - Get copy trading insights
- `/simulate <strategy>` - Simulate following a strategy

### Phase 17: Advanced Analytics UI

**Features:**
- Interactive menu system
- Drill-down navigation
- Filtering and sorting
- Charts and visualizations
- Export capabilities

**Commands:**
- `/analytics` - Main analytics dashboard
- `/insights` - Copy trading insights
- `/performance` - Performance analysis

---

## 🎯 Priority Implementation Order

### Week 1: Foundation
1. Database schema extensions (Phase 11)
2. Group management (Phase 12)
3. Update signal creation to track group/user

### Week 2: Forwarding & Basic Analytics
4. Signal forwarding (Phase 13)
5. Group analytics computation (Phase 14 - backend)
6. User analytics computation (Phase 15 - backend)

### Week 3: Analytics UI
7. Group analytics UI (Phase 14 - frontend)
8. User analytics UI (Phase 15 - frontend)
9. Leaderboards

### Week 4: Strategy & Polish
10. Copy trading strategy engine (Phase 16)
11. Advanced analytics UI (Phase 17)
12. Testing & optimization

---

## 📊 Current Bot Capabilities

### ✅ Working Now
- Bot can be added to a Telegram group
- Bot reads all messages in the group
- Bot detects Solana token signals (mint addresses)
- Bot fetches token metadata from Helius
- Bot fetches entry price from Helius
- Bot tracks price over time
- Bot detects threshold hits (2x, 3x, 5x, 10x)
- Bot sends notifications for new signals
- Bot can generate charts

### ❌ Not Working Yet
- Multi-group monitoring
- Signal forwarding
- Group/user analytics
- Copy trading insights
- Advanced analytics dashboard
- Leaderboards UI
- Settings/configuration

---

## 🔧 Next Immediate Steps

1. **Update Database Schema** - Add Group, User, GroupMetric, UserMetric models
2. **Create Migration** - Run `npx prisma migrate dev`
3. **Update Signal Creation** - Link signals to groups and users
4. **Implement Group Management** - Commands to add/remove groups
5. **Implement Forwarding** - Forward signals to destination group
6. **Build Analytics Backend** - Compute group/user metrics
7. **Build Analytics UI** - Telegram interface for analytics

Would you like me to start implementing these features?




