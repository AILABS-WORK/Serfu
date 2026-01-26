import { prisma } from '../db';
import { logger } from '../utils/logger';
import { getEntryTime } from './metricsUtils';
import axios from 'axios';

// ============================================================================
// TYPES
// ============================================================================

export interface ValidationIssue {
  signalId: number;
  mint: string;
  type: 'ATH_BELOW_ENTRY' | 'MISSING_ATH' | 'INVALID_TIME' | 'DRAWDOWN_AFTER_ATH' | 
        'MISSING_ENTRY' | 'STALE_METRICS' | 'NEGATIVE_TIME' | 'IMPOSSIBLE_MULTIPLE';
  severity: 'error' | 'warning' | 'info';
  message: string;
  currentValue?: number;
  expectedValue?: number;
}

export interface ValidationReport {
  totalSignals: number;
  validatedSignals: number;
  issueCount: number;
  errorCount: number;
  warningCount: number;
  infoCount: number;
  issues: ValidationIssue[];
  summary: {
    missingAthCount: number;
    athBelowEntryCount: number;
    invalidTimeCount: number;
    staleMetricsCount: number;
    healthScore: number; // 0-100
    // NEW: Analytics readiness
    readyForAnalytics: number;
    hasValidAth: number;
    unfixableCount: number; // Tokens with no OHLCV data available
  };
  generatedAt: Date;
}

// ============================================================================
// VALIDATION FUNCTIONS
// ============================================================================

/**
 * Validates a single signal's metrics for consistency and correctness.
 */
export const validateSignalMetrics = (signal: {
  id: number;
  mint: string;
  entryPrice: number | null;
  entryPriceAt: Date | null;
  detectedAt: Date;
  metrics: {
    athPrice: number;
    athMultiple: number;
    athAt: Date;
    timeToAth: number | null;
    maxDrawdown: number;
    currentPrice: number;
    currentMultiple: number;
    updatedAt: Date;
    minLowPrice?: number | null;
    minLowAt?: Date | null;
  } | null;
}): ValidationIssue[] => {
  const issues: ValidationIssue[] = [];
  
  // Check for missing entry price
  if (!signal.entryPrice || signal.entryPrice <= 0) {
    issues.push({
      signalId: signal.id,
      mint: signal.mint,
      type: 'MISSING_ENTRY',
      severity: 'error',
      message: 'Signal has no valid entry price'
    });
    return issues; // Can't validate further without entry price
  }
  
  // Check for missing metrics
  if (!signal.metrics) {
    issues.push({
      signalId: signal.id,
      mint: signal.mint,
      type: 'MISSING_ATH',
      severity: 'warning',
      message: 'Signal has no metrics record'
    });
    return issues;
  }
  
  const { metrics } = signal;
  const entryPrice = signal.entryPrice;
  const entryTime = getEntryTime(signal)?.getTime() || signal.detectedAt.getTime();
  
  // Check ATH is not below entry
  if (metrics.athPrice > 0 && metrics.athPrice < entryPrice * 0.95) {
    issues.push({
      signalId: signal.id,
      mint: signal.mint,
      type: 'ATH_BELOW_ENTRY',
      severity: 'warning',
      message: `ATH price (${metrics.athPrice.toFixed(8)}) is below entry price (${entryPrice.toFixed(8)})`,
      currentValue: metrics.athPrice,
      expectedValue: entryPrice
    });
  }
  
  // Check ATH multiple is reasonable (not > 10000x or negative)
  if (metrics.athMultiple <= 0 || metrics.athMultiple > 10000) {
    issues.push({
      signalId: signal.id,
      mint: signal.mint,
      type: 'IMPOSSIBLE_MULTIPLE',
      severity: metrics.athMultiple <= 0 ? 'error' : 'warning',
      message: `ATH multiple (${metrics.athMultiple.toFixed(2)}x) is ${metrics.athMultiple <= 0 ? 'invalid' : 'unusually high'}`,
      currentValue: metrics.athMultiple
    });
  }
  
  // Check time to ATH is not negative
  if (metrics.timeToAth !== null && metrics.timeToAth < 0) {
    issues.push({
      signalId: signal.id,
      mint: signal.mint,
      type: 'NEGATIVE_TIME',
      severity: 'error',
      message: `Time to ATH is negative (${metrics.timeToAth}ms)`,
      currentValue: metrics.timeToAth
    });
  }
  
  // Check ATH timestamp is after entry
  if (metrics.athAt) {
    const athTime = metrics.athAt.getTime();
    if (athTime < entryTime - 60000) { // Allow 1 minute tolerance
      issues.push({
        signalId: signal.id,
        mint: signal.mint,
        type: 'INVALID_TIME',
        severity: 'warning',
        message: `ATH time (${metrics.athAt.toISOString()}) is before entry time`,
        currentValue: athTime,
        expectedValue: entryTime
      });
    }
  }
  
  // Check drawdown is before ATH (if minLowAt exists)
  if (metrics.minLowAt && metrics.athAt) {
    const minLowTime = metrics.minLowAt.getTime();
    const athTime = metrics.athAt.getTime();
    
    // Drawdown should typically be before ATH (recovery pattern)
    // But this isn't always the case, so just log as info
    if (minLowTime > athTime && metrics.maxDrawdown < -10) {
      issues.push({
        signalId: signal.id,
        mint: signal.mint,
        type: 'DRAWDOWN_AFTER_ATH',
        severity: 'info',
        message: `Lowest point occurred after ATH (may indicate ongoing drawdown)`,
        currentValue: minLowTime,
        expectedValue: athTime
      });
    }
  }
  
  // Check for stale metrics
  // - Info: > 1 hour old (just informational)
  // - Warning: > 24 hours old (may need refresh)
  const metricsAge = Date.now() - metrics.updatedAt.getTime();
  const ONE_HOUR = 60 * 60 * 1000;
  const ONE_DAY = 24 * ONE_HOUR;
  
  if (metricsAge > ONE_DAY) {
    issues.push({
      signalId: signal.id,
      mint: signal.mint,
      type: 'STALE_METRICS',
      severity: 'warning',
      message: `Metrics are ${Math.round(metricsAge / ONE_HOUR)} hours old - needs refresh`,
      currentValue: metricsAge
    });
  } else if (metricsAge > ONE_HOUR) {
    // Don't report as issue - just informational, background jobs will refresh
  }
  
  return issues;
};

/**
 * Validates all signals in the database and generates a report.
 */
export const runValidationCheck = async (options?: {
  limit?: number;
  onlyActive?: boolean;
  minAthMultiple?: number;
}): Promise<ValidationReport> => {
  const startTime = Date.now();
  logger.info('[Validation] Starting backfill data validation...');
  
  const whereClause: any = {
    entryPrice: { not: null }
  };
  
  if (options?.onlyActive) {
    whereClause.trackingStatus = 'ACTIVE';
  }
  
  const signals = await prisma.signal.findMany({
    where: whereClause,
    include: {
      metrics: true
    },
    take: options?.limit || 10000,
    orderBy: { detectedAt: 'desc' }
  });
  
  logger.info(`[Validation] Checking ${signals.length} signals...`);
  
  const allIssues: ValidationIssue[] = [];
  let validatedCount = 0;
  
  for (const signal of signals) {
    const issues = validateSignalMetrics({
      id: signal.id,
      mint: signal.mint,
      entryPrice: signal.entryPrice,
      entryPriceAt: signal.entryPriceAt,
      detectedAt: signal.detectedAt,
      metrics: signal.metrics ? {
        athPrice: signal.metrics.athPrice,
        athMultiple: signal.metrics.athMultiple,
        athAt: signal.metrics.athAt,
        timeToAth: signal.metrics.timeToAth,
        maxDrawdown: signal.metrics.maxDrawdown,
        currentPrice: signal.metrics.currentPrice,
        currentMultiple: signal.metrics.currentMultiple,
        updatedAt: signal.metrics.updatedAt,
        minLowPrice: signal.metrics.minLowPrice,
        minLowAt: signal.metrics.minLowAt
      } : null
    });
    
    allIssues.push(...issues);
    validatedCount++;
  }
  
  // Categorize issues
  const errorCount = allIssues.filter(i => i.severity === 'error').length;
  const warningCount = allIssues.filter(i => i.severity === 'warning').length;
  const infoCount = allIssues.filter(i => i.severity === 'info').length;
  
  // Count specific issue types
  const missingAthCount = allIssues.filter(i => i.type === 'MISSING_ATH').length;
  const athBelowEntryCount = allIssues.filter(i => i.type === 'ATH_BELOW_ENTRY').length;
  const invalidTimeCount = allIssues.filter(i => 
    i.type === 'INVALID_TIME' || i.type === 'NEGATIVE_TIME'
  ).length;
  const staleMetricsCount = allIssues.filter(i => i.type === 'STALE_METRICS').length;
  
  // NEW: Calculate analytics readiness
  // A signal is "ready for analytics" if it has:
  // 1. Valid metrics record
  // 2. ATH >= entry price (or ATH = entry)
  // 3. No negative timeToAth
  // 4. athAt >= entryTime
  const signalsWithMetrics = signals.filter(s => s.metrics).length;
  
  const signalIdsWithErrors = new Set(
    allIssues
      .filter(i => i.severity === 'error' || i.type === 'ATH_BELOW_ENTRY' || i.type === 'INVALID_TIME')
      .map(i => i.signalId)
  );
  
  // Signals with valid ATH (has metrics AND athMultiple >= 1)
  const hasValidAth = signals.filter(s => 
    s.metrics && s.metrics.athMultiple >= 1 && s.metrics.athPrice > 0
  ).length;
  
  // Signals ready for analytics (has valid metrics, no critical errors)
  const readyForAnalytics = signals.filter(s => 
    s.metrics && 
    s.metrics.athMultiple >= 1 && 
    !signalIdsWithErrors.has(s.id) &&
    (s.metrics.timeToAth === null || s.metrics.timeToAth >= 0)
  ).length;
  
  // Unfixable = missing ATH (no OHLCV data available)
  const unfixableCount = missingAthCount;
  
  // Calculate health score (0-100) based on analytics readiness
  const readinessPercent = signals.length > 0 ? (readyForAnalytics / signals.length) * 100 : 0;
  const errorPenalty = Math.min(errorCount * 2, 20); // Reduced penalty
  const healthScore = Math.max(0, Math.min(100, readinessPercent - errorPenalty));
  
  const report: ValidationReport = {
    totalSignals: signals.length,
    validatedSignals: validatedCount,
    issueCount: allIssues.length,
    errorCount,
    warningCount,
    infoCount,
    issues: allIssues.slice(0, 100), // Limit to first 100 issues
    summary: {
      missingAthCount,
      athBelowEntryCount,
      invalidTimeCount,
      staleMetricsCount,
      healthScore: Math.round(healthScore),
      // NEW analytics readiness metrics
      readyForAnalytics,
      hasValidAth,
      unfixableCount
    },
    generatedAt: new Date()
  };
  
  const elapsed = Date.now() - startTime;
  logger.info(`[Validation] Complete in ${elapsed}ms. Health Score: ${report.summary.healthScore}%, Errors: ${errorCount}, Warnings: ${warningCount}`);
  
  return report;
};

/**
 * Auto-fix common issues found during validation.
 * Fixes:
 * - ATH_BELOW_ENTRY: Set ATH to entry price
 * - NEGATIVE_TIME: Fix timeToAth to 0 and athAt to entryTime
 * - INVALID_TIME: Fix athAt to be at/after entryTime
 */
export const autoFixIssues = async (report: ValidationReport): Promise<{
  fixedCount: number;
  failedCount: number;
  details: string[];
}> => {
  const details: string[] = [];
  let fixedCount = 0;
  let failedCount = 0;
  
  // Fix ATH_BELOW_ENTRY, NEGATIVE_TIME, and INVALID_TIME issues
  const fixableIssues = report.issues.filter(i => 
    i.type === 'ATH_BELOW_ENTRY' || 
    i.type === 'NEGATIVE_TIME' || 
    i.type === 'INVALID_TIME'
  );
  
  logger.info(`[Validation] Auto-fixing ${fixableIssues.length} issues (ATH_BELOW_ENTRY, NEGATIVE_TIME, INVALID_TIME)...`);
  
  // Group by signalId to avoid duplicate fixes
  const signalIds = [...new Set(fixableIssues.map(i => i.signalId))];
  
  for (const signalId of signalIds) {
    try {
      // Get the signal with fresh data
      const signal = await prisma.signal.findUnique({
        where: { id: signalId },
        include: { metrics: true }
      });
      
      if (!signal || !signal.metrics || !signal.entryPrice) {
        failedCount++;
        continue;
      }
      
      const entryTime = getEntryTime(signal) || signal.detectedAt;
      const entryTimeMs = entryTime.getTime();
      const metrics = signal.metrics;
      
      const updates: any = { updatedAt: new Date() };
      let needsUpdate = false;
      
      // Fix 1: ATH price below entry → set ATH to entry
      if (metrics.athPrice < signal.entryPrice * 0.95) {
        updates.athPrice = signal.entryPrice;
        updates.athMultiple = 1.0;
        updates.athAt = entryTime;
        updates.timeToAth = 0;
        needsUpdate = true;
        details.push(`Signal ${signalId}: ATH set to entry price`);
      }
      
      // Fix 2: Negative timeToAth → set to 0
      if (metrics.timeToAth !== null && metrics.timeToAth < 0) {
        updates.timeToAth = 0;
        // Also fix athAt if it's before entry
        if (metrics.athAt && metrics.athAt.getTime() < entryTimeMs) {
          updates.athAt = entryTime;
        }
        needsUpdate = true;
        details.push(`Signal ${signalId}: Fixed negative timeToAth`);
      }
      
      // Fix 3: ATH timestamp before entry → set to entry time
      if (metrics.athAt && metrics.athAt.getTime() < entryTimeMs - 60000) {
        updates.athAt = entryTime;
        updates.timeToAth = 0;
        needsUpdate = true;
        details.push(`Signal ${signalId}: Fixed athAt to entry time`);
      }
      
      // Fix 4: minLowAt before entry → set to entry time
      if (metrics.minLowAt && metrics.minLowAt.getTime() < entryTimeMs - 60000) {
        updates.minLowAt = entryTime;
        needsUpdate = true;
        details.push(`Signal ${signalId}: Fixed minLowAt to entry time`);
      }
      
      if (needsUpdate) {
        await prisma.signalMetric.update({
          where: { signalId: signal.id },
          data: updates
        });
        fixedCount++;
      }
      
    } catch (err: any) {
      failedCount++;
      details.push(`Failed to fix signal ${signalId}: ${err.message}`);
    }
  }
  
  logger.info(`[Validation] Auto-fix complete. Fixed: ${fixedCount}, Failed: ${failedCount}`);
  
  return { fixedCount, failedCount, details };
};

// ============================================================================
// TARGETED FIX: Re-fetch with minute candles for problematic signals
// ============================================================================

interface MinuteCandle {
  timestamp: number;
  high: number;
  low: number;
  close: number;
}

const poolCache = new Map<string, string | null>();

const fetchMinuteCandles = async (mint: string, fromTime: number): Promise<MinuteCandle[]> => {
  try {
    // Check cache for pool address
    let poolAddress = poolCache.get(mint);
    
    if (poolAddress === undefined) {
      const poolResponse = await axios.get(
        `https://api.geckoterminal.com/api/v2/networks/solana/tokens/${mint}/pools`,
        { params: { page: 1, limit: 1 }, timeout: 5000 }
      );
      const addr = poolResponse.data?.data?.[0]?.attributes?.address;
      poolAddress = addr ? String(addr) : null;
      poolCache.set(mint, poolAddress);
    }
    
    if (!poolAddress) return [];
    
    // Fetch minute candles (most accurate for entry timing)
    const response = await axios.get(
      `https://api.geckoterminal.com/api/v2/networks/solana/pools/${poolAddress}/ohlcv/minute`,
      { params: { limit: 1000 }, timeout: 10000 }
    );
    
    const list = response.data?.data?.attributes?.ohlcv_list || [];
    return list.map((c: any[]) => ({
      timestamp: c[0] * 1000,
      high: c[2],
      low: c[3],
      close: c[4]
    })).reverse();
    
  } catch (err) {
    return [];
  }
};

/**
 * Targeted fix for signals with timing issues.
 * Uses minute candles for precision instead of full re-backfill.
 */
export const fixTimingIssues = async (options?: {
  limit?: number;
  dryRun?: boolean;
}): Promise<{
  processed: number;
  fixed: number;
  skipped: number;
  errors: number;
  details: string[];
}> => {
  const dryRun = options?.dryRun ?? false;
  const limit = options?.limit ?? 500;
  
  logger.info(`[ValidationFix] Starting targeted timing fix (dryRun=${dryRun}, limit=${limit})`);
  
  // Find signals with negative timeToAth or athAt before entry
  const problematicSignals = await prisma.signal.findMany({
    where: {
      entryPrice: { not: null, gt: 0 },
      metrics: {
        OR: [
          { timeToAth: { lt: 0 } },
          // We'll check athAt < entryTime in code
        ]
      }
    },
    include: { metrics: true },
    take: limit
  });
  
  // Also find signals where athAt < entryTime
  const allWithMetrics = await prisma.signal.findMany({
    where: {
      entryPrice: { not: null, gt: 0 },
      metrics: { isNot: null }
    },
    include: { metrics: true },
    take: 10000
  });
  
  const invalidTimeSignals = allWithMetrics.filter(s => {
    if (!s.metrics || !s.metrics.athAt) return false;
    const entryTime = getEntryTime(s)?.getTime() || s.detectedAt.getTime();
    return s.metrics.athAt.getTime() < entryTime - 60000; // 1 min tolerance
  });
  
  // Combine and dedupe
  const signalMap = new Map<number, typeof problematicSignals[0]>();
  for (const s of [...problematicSignals, ...invalidTimeSignals]) {
    signalMap.set(s.id, s);
  }
  const signals = Array.from(signalMap.values()).slice(0, limit);
  
  logger.info(`[ValidationFix] Found ${signals.length} signals with timing issues`);
  
  const details: string[] = [];
  let processed = 0;
  let fixed = 0;
  let skipped = 0;
  let errors = 0;
  
  for (const signal of signals) {
    try {
      if (!signal.entryPrice || !signal.metrics) {
        skipped++;
        continue;
      }
      
      const entryTime = getEntryTime(signal)?.getTime() || signal.detectedAt.getTime();
      const entryPrice = signal.entryPrice;
      
      // Fetch minute candles
      const candles = await fetchMinuteCandles(signal.mint, entryTime);
      
      if (candles.length === 0) {
        // No candles - just fix to entry price/time
        if (!dryRun) {
          await prisma.signalMetric.update({
            where: { signalId: signal.id },
            data: {
              athAt: new Date(entryTime),
              timeToAth: 0,
              updatedAt: new Date()
            }
          });
        }
        details.push(`Signal ${signal.id}: No candles, set to entry time`);
        fixed++;
        processed++;
        continue;
      }
      
      // Filter to ONLY candles AFTER entry
      const validCandles = candles.filter(c => c.timestamp >= entryTime);
      
      // Calculate ATH from valid candles
      let athPrice = entryPrice;
      let athAt = entryTime;
      let minLow = entryPrice;
      let minLowAt = entryTime;
      
      for (const c of validCandles) {
        if (c.high > athPrice) {
          athPrice = c.high;
          athAt = c.timestamp;
        }
        if (c.low > 0 && c.low < minLow) {
          minLow = c.low;
          minLowAt = c.timestamp;
        }
      }
      
      // Ensure ATH >= entry
      if (athPrice < entryPrice) {
        athPrice = entryPrice;
        athAt = entryTime;
      }
      
      const athMultiple = athPrice / entryPrice;
      const timeToAth = Math.max(0, athAt - entryTime);
      const maxDrawdown = minLow < entryPrice ? ((minLow - entryPrice) / entryPrice) * 100 : 0;
      
      const oldTimeToAth = signal.metrics.timeToAth;
      const oldAthAt = signal.metrics.athAt?.getTime();
      
      if (!dryRun) {
        await prisma.signalMetric.update({
          where: { signalId: signal.id },
          data: {
            athPrice,
            athMultiple,
            athAt: new Date(athAt),
            timeToAth,
            maxDrawdown,
            minLowPrice: minLow,
            minLowAt: new Date(minLowAt),
            updatedAt: new Date()
          }
        });
      }
      
      details.push(
        `Signal ${signal.id} (${signal.mint.slice(0, 8)}...): ` +
        `timeToAth ${oldTimeToAth}ms → ${timeToAth}ms, ` +
        `athMult ${signal.metrics.athMultiple.toFixed(2)}x → ${athMultiple.toFixed(2)}x`
      );
      fixed++;
      processed++;
      
      // Small delay to respect rate limits
      await new Promise(r => setTimeout(r, 100));
      
      if (processed % 50 === 0) {
        logger.info(`[ValidationFix] Progress: ${processed}/${signals.length} (${fixed} fixed)`);
      }
      
    } catch (err: any) {
      errors++;
      details.push(`Signal ${signal.id}: Error - ${err.message}`);
    }
  }
  
  logger.info(`[ValidationFix] Complete: ${fixed} fixed, ${skipped} skipped, ${errors} errors`);
  
  return { processed, fixed, skipped, errors, details };
};

/**
 * Handle unfixable signals (no OHLCV data available).
 * Sets ATH = entry price so they can be included in analytics.
 */
export const fixUnfixableSignals = async (): Promise<{
  fixed: number;
  details: string[];
}> => {
  logger.info('[ValidationFix] Fixing unfixable signals (setting ATH = entry price)...');
  
  // Find signals with metrics = null or ATH = 0
  const signals = await prisma.signal.findMany({
    where: {
      entryPrice: { not: null, gt: 0 },
      OR: [
        { metrics: null },
        { metrics: { athPrice: { lte: 0 } } }
      ]
    },
    select: {
      id: true,
      mint: true,
      entryPrice: true,
      entrySupply: true,
      entryMarketCap: true,
      entryPriceAt: true,
      detectedAt: true,
      metrics: true
    },
    take: 500
  });
  
  logger.info(`[ValidationFix] Found ${signals.length} signals with no ATH data`);
  
  const details: string[] = [];
  let fixed = 0;
  const now = new Date();
  
  for (const signal of signals) {
    if (!signal.entryPrice) continue;
    
    const entryTime = getEntryTime(signal) || signal.detectedAt;
    const entryPrice = signal.entryPrice;
    const entrySupply = signal.entrySupply || (signal.entryMarketCap && entryPrice > 0 ? signal.entryMarketCap / entryPrice : null);
    const entryMarketCap = signal.entryMarketCap || (entrySupply ? entryPrice * entrySupply : null);
    
    try {
      if (signal.metrics) {
        // Update existing metrics
        await prisma.signalMetric.update({
          where: { signalId: signal.id },
          data: {
            athPrice: entryPrice,
            athMultiple: 1.0,
            athAt: entryTime,
            timeToAth: 0,
            maxDrawdown: 0,
            currentPrice: entryPrice,
            currentMultiple: 1.0,
            currentMarketCap: entryMarketCap,
            athMarketCap: entryMarketCap,
            updatedAt: now
          }
        });
      } else {
        // Create new metrics
        await prisma.signalMetric.create({
          data: {
            signalId: signal.id,
            athPrice: entryPrice,
            athMultiple: 1.0,
            athAt: entryTime,
            timeToAth: 0,
            maxDrawdown: 0,
            currentPrice: entryPrice,
            currentMultiple: 1.0,
            currentMarketCap: entryMarketCap,
            athMarketCap: entryMarketCap,
            updatedAt: now
          }
        });
      }
      
      fixed++;
      details.push(`Signal ${signal.id} (${signal.mint.slice(0, 8)}...): Set ATH = entry`);
    } catch (err: any) {
      details.push(`Signal ${signal.id}: Error - ${err.message}`);
    }
  }
  
  logger.info(`[ValidationFix] Fixed ${fixed} unfixable signals`);
  return { fixed, details };
};

/**
 * Generates a human-readable validation summary.
 */
export const formatValidationReport = (report: ValidationReport): string => {
  let msg = `🔍 *Backfill Validation Report*\n\n`;
  
  // Health score with emoji
  const healthEmoji = report.summary.healthScore >= 90 ? '🟢' 
    : report.summary.healthScore >= 70 ? '🟡' 
    : '🔴';
  msg += `${healthEmoji} *Health Score:* ${report.summary.healthScore}%\n\n`;
  
  // ANALYTICS READINESS - Most important section
  const readyPct = report.totalSignals > 0 
    ? ((report.summary.readyForAnalytics / report.totalSignals) * 100).toFixed(1)
    : '0';
  const readyEmoji = parseFloat(readyPct) >= 95 ? '✅' : parseFloat(readyPct) >= 80 ? '🟡' : '⚠️';
  
  msg += `📈 *Analytics Readiness:*\n`;
  msg += `${readyEmoji} *${report.summary.readyForAnalytics}/${report.totalSignals}* signals ready (${readyPct}%)\n`;
  msg += `• Has Valid ATH: ${report.summary.hasValidAth}\n`;
  msg += `• Unfixable (no data): ${report.summary.unfixableCount}\n\n`;
  
  // Count specific error types from issues
  const missingEntryCount = report.issues.filter(i => i.type === 'MISSING_ENTRY').length;
  const impossibleMultCount = report.issues.filter(i => i.type === 'IMPOSSIBLE_MULTIPLE').length;
  const negativeTimeCount = report.issues.filter(i => i.type === 'NEGATIVE_TIME').length;
  
  // Issue breakdown
  msg += `📋 *Issue Breakdown:*\n`;
  msg += `• ❌ Errors: ${report.errorCount}\n`;
  msg += `• ⚠️ Warnings: ${report.warningCount}\n`;
  msg += `• ℹ️ Info: ${report.infoCount}\n\n`;
  
  // Specific issues with actionable info
  const hasIssues = report.errorCount > 0 || report.warningCount > 0 || report.summary.missingAthCount > 0;
  if (hasIssues) {
    msg += `🔎 *Issue Types:*\n`;
    if (missingEntryCount > 0) {
      msg += `• 🚫 No Entry Price: ${missingEntryCount} (can't calc ATH)\n`;
    }
    if (impossibleMultCount > 0) {
      msg += `• ❓ Invalid ATH: ${impossibleMultCount} (≤0 or >10000x)\n`;
    }
    if (negativeTimeCount > 0 || report.summary.invalidTimeCount > 0) {
      const timeIssues = Math.max(negativeTimeCount, report.summary.invalidTimeCount);
      msg += `• ⏱️ Time Issues: ${timeIssues} ← "Fix Timing"\n`;
    }
    if (report.summary.missingAthCount > 0) {
      msg += `• 📭 No Metrics: ${report.summary.missingAthCount} ← "Fix Missing"\n`;
    }
    if (report.summary.athBelowEntryCount > 0) {
      msg += `• ⬇️ ATH < Entry: ${report.summary.athBelowEntryCount}\n`;
    }
    if (report.summary.staleMetricsCount > 0) {
      msg += `• 📅 Stale (>24h): ${report.summary.staleMetricsCount}\n`;
    }
  } else {
    msg += `✅ *All signals have valid metrics!*\n`;
  }
  
  // Top errors (if any)
  const topErrors = report.issues.filter(i => i.severity === 'error').slice(0, 3);
  if (topErrors.length > 0) {
    msg += `\n🔴 *Sample Errors:*\n`;
    for (const issue of topErrors) {
      const shortMsg = issue.message.length > 50 ? issue.message.slice(0, 47) + '...' : issue.message;
      msg += `• \`${issue.mint.slice(0, 8)}...\`: ${shortMsg}\n`;
    }
  }
  
  msg += `\n_Generated: ${report.generatedAt.toISOString()}_`;
  
  return msg;
};

