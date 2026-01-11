# Deployment Guide

This guide covers deploying the AlphaColor Bot to production (Railway, Heroku, etc.).

## Prerequisites

- Database (PostgreSQL) - Railway provides this
- Redis instance - Railway provides this
- Environment variables configured
- Git repository connected to deployment platform

---

## Railway Deployment

### Step 1: Connect Repository

1. Go to [Railway](https://railway.app)
2. Click "New Project"
3. Select "Deploy from GitHub repo"
4. Choose your repository

### Step 2: Add Services

You'll need three services:

1. **PostgreSQL Database**
   - Click "New" → "Database" → "Add PostgreSQL"
   - Railway will create a database and set `DATABASE_URL` automatically

2. **Redis**
   - Click "New" → "Database" → "Add Redis"
   - Railway will create Redis and set `REDIS_URL` automatically

3. **Node.js Service** (Your Bot)
   - Click "New" → "GitHub Repo"
   - Select your repository
   - Railway will auto-detect Node.js

### Step 3: Configure Environment Variables

In your Node.js service, add these environment variables:

**Required:**
```
BOT_TOKEN=your_telegram_bot_token
HELIUS_API_KEY=your_helius_api_key
NODE_ENV=production
RUN_MIGRATIONS=true
```

**Optional:**
```
LOG_LEVEL=info
```

**Note**: `DATABASE_URL` and `REDIS_URL` are automatically set by Railway when you add those services.

### Step 4: Run Database Migrations

The bot will automatically run migrations on startup if `RUN_MIGRATIONS=true` is set.

**Manual Migration (if needed):**

1. Open Railway dashboard
2. Go to your Node.js service
3. Click "Deployments" → "Latest"
4. Click "View Logs"
5. Or use Railway CLI:
   ```bash
   railway run npx prisma migrate deploy
   ```

### Step 5: Verify Deployment

1. Check logs for:
   - ✅ "Migrations completed successfully"
   - ✅ "Connected to Postgres"
   - ✅ "Connected to Redis"
   - ✅ "Bot launched!"

2. Test in Telegram:
   - Send `/ping` to your bot
   - Should respond with "Pong!"

---

## Troubleshooting Deployment

### Error: "Table does not exist"

**Problem**: Database migrations haven't been run.

**Solution**:
1. Set `RUN_MIGRATIONS=true` in environment variables
2. Redeploy the service
3. Or manually run: `railway run npx prisma migrate deploy`

### Error: "Can't reach database server"

**Problem**: `DATABASE_URL` is incorrect or database isn't ready.

**Solution**:
1. Verify PostgreSQL service is running in Railway
2. Check `DATABASE_URL` is set automatically
3. Wait a few minutes after creating database (it needs to initialize)

### Error: "PrismaClientConstructorValidationError"

**Problem**: Prisma 7.2.0 requires adapter configuration.

**Solution**: This should be fixed in the code. If you see this:
1. Ensure `@prisma/adapter-pg` is in `package.json`
2. Verify `src/db/index.ts` uses the adapter
3. Rebuild: `npm run build`

### Bot Not Responding

**Problem**: Bot is deployed but not responding to commands.

**Solution**:
1. Check `BOT_TOKEN` is correct
2. Verify bot privacy is OFF in BotFather
3. Check Railway logs for errors
4. Ensure bot is added to groups

---

## Manual Migration Commands

If you need to run migrations manually:

```bash
# Using Railway CLI
railway run npx prisma migrate deploy

# Or connect to service shell
railway shell
npx prisma migrate deploy
```

---

## Environment Variables Reference

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `BOT_TOKEN` | Yes | Telegram bot token | `123456789:ABC...` |
| `DATABASE_URL` | Yes | PostgreSQL connection | Auto-set by Railway |
| `REDIS_URL` | Yes | Redis connection | Auto-set by Railway |
| `HELIUS_API_KEY` | Yes | Helius API key | `your-key-here` |
| `NODE_ENV` | No | Environment | `production` |
| `RUN_MIGRATIONS` | No | Auto-run migrations | `true` |
| `LOG_LEVEL` | No | Logging level | `info` |

---

## Post-Deployment Checklist

- [ ] Database migrations completed
- [ ] Bot responds to `/ping`
- [ ] Bot can be added to groups
- [ ] `/groups` command works
- [ ] `/setdestination` works
- [ ] Signals are being detected
- [ ] Signals are being forwarded
- [ ] Analytics commands work

---

## Monitoring

### Railway Logs

1. Go to Railway dashboard
2. Select your Node.js service
3. Click "Deployments" → "Latest"
4. View real-time logs

### Health Checks

The bot responds to `/ping` for health checks. Set up monitoring to:
- Ping the bot every 5 minutes
- Alert if no response

---

## Updates and Redeployments

When you push to GitHub:
1. Railway automatically detects changes
2. Builds new version
3. Runs migrations (if `RUN_MIGRATIONS=true`)
4. Deploys new version
5. Old version is kept for rollback

**Rollback**:
1. Go to "Deployments"
2. Find previous working deployment
3. Click "Redeploy"

---

## Production Best Practices

1. **Always test migrations locally first**
2. **Keep `RUN_MIGRATIONS=true` for auto-migrations**
3. **Monitor logs after deployment**
4. **Set up alerts for errors**
5. **Regular database backups** (Railway provides this)
6. **Keep environment variables secure**

---

## Support

If you encounter issues:
1. Check Railway logs
2. Review this guide
3. Check main [README.md](../README.md)
4. Review [Troubleshooting](../README.md#-help--support)





