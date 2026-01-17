import { CronJob } from 'cron';
import { logger } from '../utils/logger';
import { checkPriceAlerts } from './priceAlerts';
import { updateHistoricalMetrics } from './historicalMetrics';
import { runSamplingCycle } from './sampling';

// Run price alerts every minute
export const priceAlertJob = new CronJob('* * * * *', async () => {
  try {
    await checkPriceAlerts();
  } catch (error) {
    logger.error('Error in price alert job:', error);
  }
});

// Run sampling cycle every minute (drives price samples + ATH updates)
export const samplingJob = new CronJob('* * * * *', async () => {
  try {
    await runSamplingCycle();
  } catch (error) {
    logger.error('Error in sampling job:', error);
  }
});

// Run historical metrics update every 30 minutes
export const historicalMetricsJob = new CronJob('*/30 * * * *', async () => {
  try {
    await updateHistoricalMetrics();
  } catch (error) {
    logger.error('Error in historical metrics job:', error);
  }
});

export const startJobs = () => {
  priceAlertJob.start();
  samplingJob.start();
  historicalMetricsJob.start();
  logger.info('Background jobs started (Price Alerts: 1m, Sampling: 1m, Historical Metrics: 30m)');
};








