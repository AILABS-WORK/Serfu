import dotenv from 'dotenv';
import { execSync } from 'child_process';
import { logger } from './utils/logger';
import { setupBot, launchBot } from './bot';
import { runSamplingCycle } from './jobs/sampling';
import { runAggregationCycle } from './jobs/aggregation';
import { Telegraf } from 'telegraf';
import { BotContext } from './types/bot';

dotenv.config();

const runMigrations = async () => {
  try {
    logger.info('Setting up database schema...');
    
    // Check if migrations directory exists and has migrations
    const fs = require('fs');
    const path = require('path');
    const migrationsPath = path.join(process.cwd(), 'prisma', 'migrations');
    
    let hasMigrations = false;
    try {
      if (fs.existsSync(migrationsPath)) {
        const migrationDirs = fs.readdirSync(migrationsPath);
        hasMigrations = migrationDirs.some((dir: string) => {
          const dirPath = path.join(migrationsPath, dir);
          return fs.statSync(dirPath).isDirectory() && 
                 fs.existsSync(path.join(dirPath, 'migration.sql'));
        });
      }
    } catch (e) {
      // If we can't check, assume no migrations
      hasMigrations = false;
    }
    
    if (hasMigrations) {
      // Use migrate deploy if migrations exist
      logger.info('Found migrations, running migrate deploy...');
      try {
        execSync('npx prisma migrate deploy', { stdio: 'pipe' });
        logger.info('Migrations completed successfully');
        return;
      } catch (migrateError: any) {
        logger.warn('migrate deploy failed, falling back to db push...');
        logger.warn('Error:', migrateError.message);
      }
    } else {
      logger.info('No migrations found, using db push to create schema...');
    }
    
    // Use db push to create tables directly from schema
    // This is necessary when migrations don't exist yet
    logger.info('Syncing database schema with db push...');
    
    // Try with --accept-data-loss first
    try {
      execSync('npx prisma db push --accept-data-loss', { 
        stdio: 'pipe',
        env: { ...process.env }
      });
      logger.info('✅ Database schema synced successfully - all tables created!');
    } catch (pushError: any) {
      const errorMessage = pushError.message || '';
      
      // If that fails due to existing data requiring default value
      if (errorMessage.includes('default value') || errorMessage.includes('owner_id')) {
        logger.warn('⚠️  Migration issue detected. Using --force-reset (data will be lost)...');
        logger.warn('This will reset the database. In production, consider manual migration.');
        
        if (process.env.NODE_ENV === 'production' && process.env.FORCE_RESET_DB !== 'true') {
          logger.error('❌ Cannot auto-reset in production without FORCE_RESET_DB=true');
          logger.error('Please run manually: npx prisma db push --force-reset --accept-data-loss');
          throw pushError;
        }
        
        execSync('npx prisma db push --force-reset --accept-data-loss', {
          stdio: 'inherit',
          env: { ...process.env }
        });
        logger.info('✅ Database reset and schema synced!');
      } else {
        throw pushError;
      }
    }
  } catch (error: any) {
    logger.error('❌ Database setup failed:', error.message);
    logger.error('Please run manually: npx prisma db push --accept-data-loss');
    // Don't exit - let the bot try to start anyway
    // The error will be clear in logs
  }
};

const main = async () => {
  logger.info('AlphaColor Bot starting...');
  
  // Verify environment
  if (!process.env.BOT_TOKEN) {
    logger.error('BOT_TOKEN is missing');
    process.exit(1);
  }

  // Run migrations before starting bot
  if (process.env.NODE_ENV === 'production' || process.env.RUN_MIGRATIONS === 'true') {
    await runMigrations();
  }

  try {
    const bot = setupBot();
    await launchBot(bot as Telegraf<BotContext>);

    // Start Sampling Job (Every minute)
    logger.info('Starting Sampling Scheduler...');
    setInterval(() => {
      runSamplingCycle().catch(err => logger.error('Sampling cycle failed:', err));
    }, 60 * 1000);

    // Start Aggregation Job (Every hour)
    logger.info('Starting Aggregation Scheduler...');
    setInterval(() => {
      runAggregationCycle().catch(err => logger.error('Aggregation cycle failed:', err));
    }, 60 * 60 * 1000);

    // Run once immediately
    runSamplingCycle().catch(err => logger.error('Initial sampling cycle failed:', err));
    runAggregationCycle().catch(err => logger.error('Initial aggregation cycle failed:', err));

  } catch (error) {
    logger.error('Failed to launch bot:', error);
    process.exit(1);
  }
};

main().catch((err) => {
  logger.error('Fatal error:', err);
  process.exit(1);
});

