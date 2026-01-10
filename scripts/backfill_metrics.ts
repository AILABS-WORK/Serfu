import { prisma } from '../src/db';
import { provider } from '../src/providers';
import { logger } from '../src/utils/logger';

const backfillMetrics = async () => {
  console.log('Starting metrics backfill...');
  
  // Find signals without metrics or with incomplete metrics
  const signals = await prisma.signal.findMany({
    where: {
      metrics: null,
      entryPrice: { not: null }
    }
  });

  console.log(`Found ${signals.length} signals needing metrics initialization.`);

  for (const signal of signals) {
    if (!signal.entryPrice) continue;
    
    try {
      // Get current price from Jupiter
      // Note: We can't easily get historical ATH without a history API like OHLCV
      // So for backfill, we assume ATH = max(entryPrice, currentPrice) 
      // This is a "best effort" backfill. Future tracking will catch real ATHs.
      const quote = await provider.getQuote(signal.mint);
      const currentPrice = quote.price;
      
      const multiplier = currentPrice / signal.entryPrice;
      
      // Assume ATH is at least the current price or entry price
      // If the token pumped and dumped before this script ran, we sadly miss that peak 
      // unless we integrate a historical chart API.
      const athPrice = Math.max(currentPrice, signal.entryPrice);
      const athMultiple = athPrice / signal.entryPrice;
      
      // Calculate max drawdown (simple version)
      const currentDrawdown = (currentPrice - signal.entryPrice) / signal.entryPrice;
      const maxDrawdown = Math.min(0, currentDrawdown);

      await prisma.signalMetric.create({
        data: {
          signalId: signal.id,
          currentPrice,
          currentMultiple: multiplier,
          athPrice,
          athMultiple,
          athAt: new Date(), // Approximate
          maxDrawdown,
        }
      });
      
      process.stdout.write('.');
    } catch (err) {
      console.error(`\nFailed for ${signal.mint}:`, err);
    }
  }
  
  console.log('\nBackfill complete.');
};

// Run
backfillMetrics()
  .catch(console.error)
  .finally(() => prisma.$disconnect());

