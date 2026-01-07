import dotenv from 'dotenv';
import { logger } from './utils/logger';
import { setupBot, launchBot } from './bot';
import { runSamplingCycle } from './jobs/sampling';
import { runAggregationCycle } from './jobs/aggregation';

dotenv.config();

const main = async () => {
  logger.info('AlphaColor Bot starting...');
  
  // Verify environment
  if (!process.env.BOT_TOKEN) {
    logger.error('BOT_TOKEN is missing');
    process.exit(1);
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

