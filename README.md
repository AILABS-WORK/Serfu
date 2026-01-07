# AlphaColor Signal Analytics Bot (Solana v1)

A production-grade Telegram bot for passively ingesting AlphaColor signals, tracking Solana token performance via Helius, and providing analytics.

## Prerequisites

- Node.js v18+
- PostgreSQL
- Redis (for Job Queue)
- Telegram Bot Token
- Helius API Key

## Setup

1. **Clone & Install**
   ```bash
   npm install
   ```

2. **Environment Variables**
   Copy `env.sample` to `.env` and fill in your credentials.
   ```bash
   cp env.sample .env
   ```

3. **Database**
   Start your Postgres database.
   Run migrations:
   ```bash
   npx prisma migrate dev
   ```

4. **Run**
   Development:
   ```bash
   npm run dev
   ```
   Production:
   ```bash
   npm run build
   npm start
   ```

## Architecture

- **Ingest**: Captures messages from Telegram group.
- **Parser**: Extracts Solana mints and signal metadata.
- **Jobs**: BullMQ schedulers for price sampling and aggregation.
- **Provider**: Helius API integration for high-fidelity pricing.
- **DB**: Postgres for persistent storage of signals and price samples.


## Commands

- `/menu` - Open main menu
- `/ping` - Health check

## Development

- **Prisma Studio**: `npx prisma studio` to view data.
- **Tests**: `npm test`

## QA
See `QA_WALKTHROUGH.md` for manual testing steps.


