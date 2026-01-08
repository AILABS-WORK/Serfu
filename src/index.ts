import dotenv from 'dotenv';
import { execSync } from 'child_process';
import { logger } from './utils/logger';
import { setupBot, launchBot } from './bot';
import { runSamplingCycle } from './jobs/sampling';
import { runAggregationCycle } from './jobs/aggregation';

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
    execSync('npx prisma db push --accept-data-loss', { 
      stdio: 'inherit', // Show output so we can see what's happening
      env: { ...process.env }
    });
    logger.info('✅ Database schema synced successfully - all tables created!');
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
    await launchBot(bot);

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

