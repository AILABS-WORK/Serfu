# AlphaColor Signal Analytics Bot - Build Plan

## Phase 0: Repo + Foundation
- [ ] **0.1** Initialize project structure (src folders, tests, docs)
- [ ] **0.2** Setup TypeScript, ESLint, Prettier, nodemon/ts-node
- [ ] **0.3** Setup Environment Variables (dotenv, zod validation)
- [ ] **0.4** Setup Logging (winston/pino)
- [ ] **0.5** Create README.md

## Phase 1: Database Schema (Postgres + Prisma)
- [ ] **1.1** Initialize Prisma
- [ ] **1.2** Define Schema: `raw_messages`, `signals`, `price_samples`, `threshold_events`, `signal_metrics`, `category_metrics`
- [ ] **1.3** Create Migrations
- [ ] **1.4** Implement DB Repository Layer (CRUD wrappers)
- [ ] **1.5** Unit Tests for DB Repository

## Phase 2: Helius Provider Integration
- [ ] **2.1** Define Provider Interface (Adapter Pattern)
- [ ] **2.2** Implement Helius Client (`getQuote`, `getTokenMeta`) with retry/backoff
- [ ] **2.3** Integration Tests for Helius Client (mocked)

## Phase 3: Telegram Bot Skeleton + Ingestion
- [ ] **3.1** Setup Telegraf Bot
- [ ] **3.2** Implement Middleware for Message Ingestion (store in `raw_messages`)
- [ ] **3.3** Implement Basic `/menu` command
- [ ] **3.4** Implement Pagination Utility

## Phase 4: Signal Detection + Parsing
- [ ] **4.1** Implement Mint Extraction Logic (Regex, validation)
- [ ] **4.2** Implement Signal Parser (Template matching)
- [ ] **4.3** Implement Signal Creation Logic (DB insert, initial price fetch)
- [ ] **4.4** Implement Signal Card Notification (Telegram UI)
- [ ] **4.5** Unit Tests for Parsers

## Phase 5: Price Sampling Engine
- [ ] **5.1** Setup Job Scheduler (BullMQ/Node-Schedule)
- [ ] **5.2** Implement Dynamic Sampling Logic (Age-based intervals)
- [ ] **5.3** Implement Batch Price Fetching
- [ ] **5.4** Implement Threshold Detection (2x, 3x, etc.)
- [ ] **5.5** Implement Horizon Snapshots (15m, 1h, etc.)
- [ ] **5.6** Unit Tests for Scheduler Logic

## Phase 6: Aggregation + Leaderboards
- [ ] **6.1** Implement Aggregation Jobs (Hourly/Daily)
- [ ] **6.2** Compute Category Metrics (Hit rates, Medians)
- [ ] **6.3** Implement `/leaderboard` command and view
- [ ] **6.4** Implement `/distributions` command and view

## Phase 7: Charts (PNG)
- [ ] **7.1** Setup Charting Library (Canvas/QuickChart)
- [ ] **7.2** Implement Line Chart Rendering with Overlays (Entry, Thresholds, ATH)
- [ ] **7.3** Integrate Charts into Telegram Bot (Button callback)

## Phase 8: Settings + Admin
- [ ] **8.1** Implement Admin Middleware
- [ ] **8.2** Implement Settings Menu (Sampling, Horizon, Alerts)

## Phase 9: Observability & Maintenance
- [ ] **9.1** enhanced Logging
- [ ] **9.2** Data Retention/Cleanup Jobs

## Phase 10: Final Polish
- [ ] **10.1** Final QA & Walkthrough Script
- [ ] **10.2** Documentation Cleanup

