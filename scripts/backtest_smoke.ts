import 'dotenvx/config';
import { prisma } from '../src/db';
import { runBacktest } from '../src/analytics/backtest';

async function main() {
  const signals = await prisma.signal.findMany({
    where: { metrics: { isNot: null } },
    include: { metrics: true },
    take: 50
  });

  if (signals.length === 0) {
    console.log('No signals with metrics found.');
    return;
  }

  const coverage = {
    ath: signals.filter(s => (s.metrics?.athMultiple ?? 0) > 0).length,
    time: signals.filter(s => s.metrics?.timeToAth !== null && s.metrics?.timeToAth !== undefined).length,
    dd: signals.filter(s => s.metrics?.maxDrawdown !== null && s.metrics?.maxDrawdown !== undefined).length
  };
  const coveragePct = Math.round(((coverage.ath + coverage.time + coverage.dd) / (signals.length * 3)) * 100);
  console.log(`Coverage: ${coveragePct}% (ATH ${coverage.ath}/${signals.length}, Time ${coverage.time}/${signals.length}, DD ${coverage.dd}/${signals.length})`);

  const result = runBacktest(
    signals.map(s => ({
      id: s.id,
      mint: s.mint,
      entryPrice: s.entryPrice,
      entryMarketCap: s.entryMarketCap,
      detectedAt: s.detectedAt,
      metrics: s.metrics
        ? {
            athMultiple: s.metrics.athMultiple,
            timeToAth: s.metrics.timeToAth,
            maxDrawdown: s.metrics.maxDrawdown,
            drawdownDuration: s.metrics.drawdownDuration
          }
        : null
    })),
    {
      takeProfitMultiple: 2.5,
      stopLossMultiple: 0.65,
      perTradeAmount: 1,
      feePerSide: 0
    }
  );

  console.log('Backtest result:', result);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

