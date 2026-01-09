# Fix: Database Tables Don't Exist

## Problem

You're seeing errors like:
```
The table `public.groups` does not exist in the current database.
The table `public.users` does not exist in the current database.
```

This means Prisma migrations haven't been run on your production database.

## Solution

### Option 1: Automatic Migration (Recommended)

The bot will now automatically run migrations on startup if you set:

```
RUN_MIGRATIONS=true
```

**Steps:**
1. Go to Railway dashboard
2. Select your Node.js service
3. Go to "Variables" tab
4. Add: `RUN_MIGRATIONS=true`
5. Redeploy the service

The bot will run migrations automatically on startup.

### Option 2: Manual Migration via Railway CLI

1. Install Railway CLI:
   ```bash
   npm i -g @railway/cli
   railway login
   ```

2. Link to your project:
   ```bash
   railway link
   ```

3. Run migrations:
   ```bash
   railway run npx prisma migrate deploy
   ```

### Option 3: Manual Migration via Railway Dashboard

1. Go to Railway dashboard
2. Select your Node.js service
3. Click "Deployments" → "Latest"
4. Click "View Logs"
5. Click the terminal icon (or use "Shell" option)
6. Run:
   ```bash
   npx prisma migrate deploy
   ```

### Option 4: Create Migration First (If None Exist)

If migrations don't exist yet, create them:

**On Railway:**
```bash
railway run npx prisma migrate dev --name initial_schema
```

**Or locally (if you have DATABASE_URL set):**
```bash
npx prisma migrate dev --name initial_schema
```

Then deploy:
```bash
railway run npx prisma migrate deploy
```

## Verify Migration

After running migrations, verify tables exist:

```bash
railway run npx prisma studio
```

Or check in Railway PostgreSQL service:
- Go to PostgreSQL service
- Click "Query" tab
- Run: `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public';`

You should see:
- `groups`
- `users`
- `raw_messages`
- `signals`
- `price_samples`
- `threshold_events`
- `signal_metrics`
- `category_metrics`
- `group_metrics`
- `user_metrics`
- `forwarded_signals`
- `copy_trading_strategies`

## Quick Fix (Railway)

**Fastest way to fix right now:**

1. In Railway, go to your Node.js service
2. Add environment variable: `RUN_MIGRATIONS=true`
3. Redeploy (or the bot will run migrations on next restart)

The updated code will automatically run migrations on startup.

## Still Having Issues?

1. Check Railway logs for migration errors
2. Verify `DATABASE_URL` is set correctly
3. Ensure PostgreSQL service is running
4. Check database permissions

---

**Note**: The bot code has been updated to automatically run migrations on startup when `RUN_MIGRATIONS=true` is set. This is the recommended approach for production.


