import dotenv from 'dotenv';
import { execSync } from 'child_process';
import { logger } from './utils/logger';
import { setupBot, launchBot } from './bot';
import { runSamplingCycle } from './jobs/sampling';
import { runAggregationCycle } from './jobs/aggregation';

dotenv.config();

const runMigrations = async () => {
  try {
    logger.info('Running database migrations...');
    
    // Try migrate deploy first (for existing migrations)
    try {
      execSync('npx prisma migrate deploy', { stdio: 'pipe' });
      logger.info('Migrations completed successfully');
      return;
    } catch (migrateError) {
      logger.warn('migrate deploy failed, trying db push...');
    }
    
    // Fallback to db push (creates tables directly from schema)
    // This is useful when migrations don't exist yet
    logger.info('Using db push to sync schema...');
    execSync('npx prisma db push --accept-data-loss', { stdio: 'pipe' });
    logger.info('Database schema synced successfully');
  } catch (error) {
    logger.error('Database setup failed:', error);
    logger.error('Please run migrations manually: npx prisma migrate deploy');
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

