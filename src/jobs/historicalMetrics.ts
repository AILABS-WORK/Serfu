import { prisma } from '../db';
import { geckoTerminal } from '../providers/geckoTerminal';
import { bitquery } from '../providers/bitquery';
import { logger } from '../utils/logger';

/**
 * Periodically checks historical data for active signals to ensure
 * we captured the true ATH and Drawdown, even if the bot missed a tick.
 */
export const updateHistoricalMetrics = async () => {
  try {
    logger.info('Starting historical metrics update job...');
    
    // Get active signals
    // OPTIMIZATION: Only check signals created in the last 7 days for detailed "Recent Calls" accuracy
    // or sort by last updated to prioritize stale ones.
    const signals = await prisma.signal.findMany({
      where: {
        trackingStatus: 'ACTIVE',
        entryPrice: { not: null },
        detectedAt: {
             gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) // Last 7 days
        }
      },
      orderBy: { detectedAt: 'desc' }
    });

    logger.info(`Checking history for ${signals.length} active signals (last 7 days)...`);

    for (const signal of signals) {
      if (!signal.entryPrice || !signal.detectedAt) continue;

      try {
        const now = Date.now();
        const ageHours = (now - signal.detectedAt.getTime()) / (1000 * 60 * 60);
        
        let ohlcv: any[] = [];
        let source = 'gecko';

        // Priority 1: Bitquery (if API Key exists)
        if (process.env.BIT_QUERY_API_KEY) {
             // Use 15-minute intervals if older than 24h to save data points, or 1-minute if recent
             // Bitquery "minutes" interval count defaults to 1?
             // Let's use 'minute' (1m) or 'hour' (1h)
             const timeframe = ageHours > 24 ? 'hour' : 'minute';
             const limit = ageHours > 24 ? 1000 : 1440; // 1000 hours or 1440 mins (24h)
             
             ohlcv = await bitquery.getOHLCV(signal.mint, timeframe, limit);
             if (ohlcv.length > 0) source = 'bitquery';
        }

        // Priority 2: GeckoTerminal (Fallback)
        if (ohlcv.length === 0) {
            let timeframe: 'minute' | 'hour' = ageHours > 16 ? 'hour' : 'minute';
            ohlcv = await geckoTerminal.getOHLCV(signal.mint, timeframe, 1000);
            
            // Fallback to hourly if minute data has gaps/doesn't reach start
            if (timeframe === 'minute' && ohlcv && ohlcv.length > 0) {
                const oldestCandle = ohlcv[0];
                const signalTime = signal.detectedAt.getTime();
                if (oldestCandle.timestamp > signalTime + 300000) { 
                     // logger.info(`Gap in minute data for ${signal.mint}, switching to hourly...`);
                     timeframe = 'hour';
                     ohlcv = await geckoTerminal.getOHLCV(signal.mint, timeframe, 1000);
                }
            }
            source = 'gecko';
        }
        
        if (!ohlcv || ohlcv.length === 0) continue;

        // Filter valid candles (after detection)
        const signalTime = signal.detectedAt.getTime();
        const validCandles = ohlcv.filter(c => c.timestamp >= signalTime - 300000); // 5 min buffer

        if (validCandles.length === 0) continue;

        let athPrice = signal.entryPrice;
        let athAt = signal.detectedAt;
        let minPrice = signal.entryPrice;

        // We re-calculate from scratch based on the fetched history to find the absolute truth
        // (Don't rely on potentially stale or incorrect DB state for ATH, trust the OHLCV)
        
        for (const candle of validCandles) {
            if (candle.high > athPrice) {
                athPrice = candle.high;
                athAt = new Date(candle.timestamp);
            }
            if (candle.low < minPrice) {
                minPrice = candle.low;
            }
        }

        // Safety check: ATH can't be lower than entry (logic wise, unless bad data)
        // If candle data is weirdly low, ensure athPrice >= entryPrice
        if (athPrice < signal.entryPrice) athPrice = signal.entryPrice;

        const athMultiple = athPrice / signal.entryPrice;
        const maxDrawdown = (minPrice - signal.entryPrice) / signal.entryPrice;

        // Upsert metrics
        // We always update if we have fresh data to keep "lastChecked" alive
        // and ensure we converge on the truth.
        const currentPrice = validCandles[validCandles.length - 1].close;
        const currentMultiple = currentPrice / signal.entryPrice;

        await prisma.signalMetric.upsert({
            where: { signalId: signal.id },
            create: {
                signalId: signal.id,
                currentPrice,
                currentMultiple,
                athPrice,
                athMultiple,
                athAt,
                maxDrawdown,
                updatedAt: new Date()
            },
            update: {
                currentPrice,
                currentMultiple,
                athPrice,
                athMultiple,
                athAt,
                maxDrawdown, // Update drawdown even if it gets "better"? No, usually max drawdown is monotonic worse.
                             // But if we re-scanned and found a deeper low, we update. 
                             // If our previous data was glitchy and showed -99% but now shows -10%, should we fix it? Yes.
                             // So just setting it to the calculated maxDrawdown from the full history is safest.
                updatedAt: new Date()
            }
         });
        
        // Rate limiting
        if (source === 'gecko') {
            await new Promise(r => setTimeout(r, 1500)); 
        } else {
            await new Promise(r => setTimeout(r, 200)); // Faster for Bitquery
        }

      } catch (err) {
        logger.error(`Error updating history for ${signal.mint}:`, err);
      }
    }
    
    logger.info('Historical metrics update complete.');
  } catch (error) {
    logger.error('Error in updateHistoricalMetrics:', error);
  }
};


