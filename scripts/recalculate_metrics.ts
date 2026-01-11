import { prisma } from '../src/db';
import { geckoTerminal } from '../src/providers/geckoTerminal';
import { logger } from '../src/utils/logger';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const recalculateMetrics = async () => {
  console.log('Starting detailed metrics recalculation (using GeckoTerminal history)...');

  // Get all active signals (or even archived ones)
  const signals = await prisma.signal.findMany({
    where: { entryPrice: { not: null } },
    orderBy: { detectedAt: 'desc' }
  });

  console.log(`Processing ${signals.length} signals...`);

  let count = 0;
  for (const signal of signals) {
    if (!signal.entryPrice || !signal.detectedAt) continue;

    try {
      // Fetch 1-hour candles to cover longer periods, or minute if recent
      // For accuracy, let's use minute candles but fetch enough to cover the duration
      // Max 1000 candles. 1000 minutes is ~16 hours. 
      // If signal is older, maybe hour candles are safer? 
      // Let's try minute first.
      
      const now = Date.now();
      const ageHours = (now - signal.detectedAt.getTime()) / (1000 * 60 * 60);
      
      let timeframe: 'minute' | 'hour' = 'minute';
      if (ageHours > 16) {
        timeframe = 'hour';
      }

      const ohlcv = await geckoTerminal.getOHLCV(signal.mint, timeframe, 1000);
      
      if (!ohlcv || ohlcv.length === 0) {
        process.stdout.write('x');
        continue;
      }

      // Filter candles that occurred AFTER the signal was detected
      const signalTime = signal.detectedAt.getTime();
      const validCandles = ohlcv.filter(c => c.timestamp >= signalTime); // or close enough

      if (validCandles.length === 0) {
        process.stdout.write('-');
        continue;
      }

      // Find Global High and Low since entry
      let athPrice = signal.entryPrice;
      let athAt = signal.detectedAt;
      let minPrice = signal.entryPrice; // For drawdown

      for (const candle of validCandles) {
        if (candle.high > athPrice) {
          athPrice = candle.high;
          athAt = new Date(candle.timestamp);
        }
        if (candle.low < minPrice) {
          minPrice = candle.low;
        }
      }

      // Calculate Metrics
      const athMultiple = athPrice / signal.entryPrice;
      const maxDrawdown = (minPrice - signal.entryPrice) / signal.entryPrice;
      
      // Upsert
      await prisma.signalMetric.upsert({
        where: { signalId: signal.id },
        create: {
            signalId: signal.id,
            currentPrice: validCandles[validCandles.length - 1].close, // approximated current
            currentMultiple: validCandles[validCandles.length - 1].close / signal.entryPrice,
            athPrice,
            athMultiple,
            athAt,
            maxDrawdown,
        },
        update: {
            athPrice,
            athMultiple,
            athAt,
            maxDrawdown: maxDrawdown < (await prisma.signalMetric.findUnique({ where: { signalId: signal.id } }))?.maxDrawdown! ? maxDrawdown : undefined, 
            // Only update DD if lower, or just overwrite? "Max Drawdown" implies the worst ever.
            // If our historical scan is comprehensive, we can overwrite.
            // But if we only scanned last 1000 candles, we might miss an old dip?
            // GeckoTerminal returns "last N candles". 
            // If signal is OLDER than 1000 candles, we might miss the beginning.
            // Safe bet: Update ATH if higher. Update Drawdown if lower.
        }
      });
      
      // Force update with our comprehensive finding
      await prisma.signalMetric.update({
        where: { signalId: signal.id },
        data: {
             athPrice,
             athMultiple,
             athAt,
             maxDrawdown, // Overwriting with "best known history"
             updatedAt: new Date()
        }
      });

      process.stdout.write('.');
      count++;
      
      // Rate limit protection
      await sleep(1000); // 1 sec delay

    } catch (err) {
      console.error(`\nError processing ${signal.mint}:`, err);
    }
  }

  console.log(`\nRecalculation complete. Updated ${count} signals.`);
};

recalculateMetrics()
  .catch(console.error)
  .finally(() => prisma.$disconnect());



