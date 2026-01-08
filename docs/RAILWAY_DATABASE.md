# Railway Database Configuration

## Database Isolation

**Good News**: Railway provides **separate database instances** for each project. You don't need to worry about port conflicts!

### How Railway Works

1. **Each Project = Separate Database**
   - When you create a PostgreSQL service in Railway, you get a unique database instance
   - Each project has its own `DATABASE_URL` with unique credentials
   - No port conflicts possible - each database runs on its own port internally

2. **Environment Variables**
   - Railway automatically provides `DATABASE_URL` when you add a PostgreSQL service
   - Each project's `DATABASE_URL` is unique and isolated
   - You can run multiple bots without any conflicts

### Example

**Project 1 (AlphaColor Bot):**
```
DATABASE_URL=postgresql://user1:pass1@postgres.railway.internal:5432/railway1
```

**Project 2 (Other Bot):**
```
DATABASE_URL=postgresql://user2:pass2@postgres.railway.internal:5432/railway2
```

These are completely separate databases - no conflicts!

## Redis Configuration

Same applies to Redis:
- Each project gets its own Redis instance
- Unique `REDIS_URL` per project
- No port conflicts

## Migration Strategy

### For New Deployments

1. Railway will automatically run migrations if `RUN_MIGRATIONS=true`
2. Or use `FORCE_RESET_DB=true` to reset database (⚠️ **WILL DELETE ALL DATA**)

### For Existing Deployments

If you have existing data and need to add `ownerId`:

**Option 1: Force Reset (Deletes Data)**
```bash
# Set in Railway environment variables:
FORCE_RESET_DB=true
RUN_MIGRATIONS=true
```

**Option 2: Manual Migration (Preserves Data)**
1. Connect to Railway database
2. Run SQL to add nullable column:
```sql
ALTER TABLE groups ADD COLUMN owner_id INTEGER;
ALTER TABLE groups ADD CONSTRAINT groups_owner_id_fkey 
  FOREIGN KEY (owner_id) REFERENCES users(id);
```
3. Backfill existing groups:
```sql
UPDATE groups 
SET owner_id = (SELECT id FROM users LIMIT 1)
WHERE owner_id IS NULL 
AND EXISTS (SELECT 1 FROM users LIMIT 1);
```

## Troubleshooting

### "Table does not exist" Error

This means migrations haven't run. Solutions:

1. **Set `RUN_MIGRATIONS=true`** in Railway environment variables
2. **Or manually run**: `npx prisma db push --accept-data-loss` in Railway console

### "Column owner_id does not exist" Error

The schema was updated but migration failed. Solutions:

1. **Force reset** (if no important data): Set `FORCE_RESET_DB=true`
2. **Manual migration** (if you have data): Run SQL commands above

### Multiple Projects

- ✅ Each project has its own database
- ✅ No conflicts between projects
- ✅ Safe to deploy multiple bots
- ✅ Each bot's data is isolated

---

**Last Updated**: January 2025

