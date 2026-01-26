import { CronJob } from 'cron';
import { logger } from '../utils/logger';
import { checkPriceAlerts } from './priceAlerts';
import { updateHistoricalMetrics } from './historicalMetrics';
import { runSamplingCycle } from './sampling';
import { runAthEnrichmentCycle } from './athEnrichment';
import { refreshLiveAth, getBackfillProgress } from './athBackfill';

// Run price alerts every minute
export const priceAlertJob = new CronJob('* * * * *', async () => {
  try {
    await checkPriceAlerts();
  } catch (error) {
    logger.error('Error in price alert job:', error);
  }
});

// Run sampling cycle every minute (drives price samples)
export const samplingJob = new CronJob('* * * * *', async () => {
  try {
    await runSamplingCycle();
  } catch (error) {
    logger.error('Error in sampling job:', error);
  }
});

// Run ATH enrichment every 10 minutes (smart filtering, minimizes API calls)
export const athEnrichmentJob = new CronJob('*/10 * * * *', async () => {
  try {
    await runAthEnrichmentCycle();
  } catch (error) {
    logger.error('Error in ATH enrichment job:', error);
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

// Live ATH refresh every 10 seconds using Jupiter batch prices
// ONLY runs after backfill is complete - this is the PRIMARY ATH tracking mechanism
// - Fetches current prices via Jupiter (fast batch API)
// - Updates ATH if current price > stored ATH
// - No OHLCV needed for ongoing ATH tracking (backfill already got historical ATH)
let liveAthInterval: NodeJS.Timeout | null = null;
let liveAthRunning = false;

const LIVE_ATH_INTERVAL_MS = 10000; // 10 seconds

const runLiveAthRefresh = async () => {
  // Prevent overlapping runs
  if (liveAthRunning) {
    logger.debug('[Live ATH] Skipping - previous run still in progress');
    return;
  }
  
  liveAthRunning = true;
  const start = Date.now();
  
  try {
    const progress = getBackfillProgress();
    
    // CRITICAL: Only run if backfill has been completed
    // Before backfill, we need OHLCV to get historical ATH
    // After backfill, Jupiter prices can maintain ATH going forward
    if (progress.status === 'running') {
      logger.debug('[Live ATH] Skipping - backfill in progress');
      return;
    }
    
    if (progress.status !== 'complete') {
      // Backfill hasn't been run yet - log and skip
      // (ATH enrichment job will handle signals without backfill)
      logger.debug(`[Live ATH] Skipping - backfill not complete (status: ${progress.status})`);
      return;
    }
    
    await refreshLiveAth({
      onlyNearAth: false, // Check all since Jupiter batch is fast
      maxTokens: 1000 // Check up to 1000 tokens per cycle
    });
    
    const duration = Date.now() - start;
    if (duration > 5000) {
      logger.info(`[Live ATH] Cycle complete in ${duration}ms (slow)`);
    }
  } catch (error) {
    logger.error('[Live ATH] Error in refresh job:', error);
  } finally {
    liveAthRunning = false;
  }
};

export const startJobs = () => {
  priceAlertJob.start();
  samplingJob.start();
  athEnrichmentJob.start();
  historicalMetricsJob.start();
  
  // Start live ATH refresh (every 10 seconds)
  if (liveAthInterval) clearInterval(liveAthInterval);
  liveAthInterval = setInterval(runLiveAthRefresh, LIVE_ATH_INTERVAL_MS);
  // Run immediately on startup
  runLiveAthRefresh();
  
  logger.info('Background jobs started (Price Alerts: 1m, Sampling: 1m, ATH Enrichment: 10m, Historical Metrics: 30m, Live ATH: 10s)');
};

export const stopJobs = () => {
  priceAlertJob.stop();
  samplingJob.stop();
  athEnrichmentJob.stop();
  historicalMetricsJob.stop();
  
  if (liveAthInterval) {
    clearInterval(liveAthInterval);
    liveAthInterval = null;
  }
  
  logger.info('Background jobs stopped');
};








