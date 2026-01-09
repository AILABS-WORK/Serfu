import { prisma } from '../db';
import { logger } from '../utils/logger';
import { getBotInstance } from '../bot/instance';

const THRESHOLDS = [2, 3, 4, 5, 10];

export const updateSignalMetrics = async (signalId: number, currentPrice: number) => {
  const signal = await prisma.signal.findUnique({
    where: { id: signalId },
    include: { metrics: true }
  });

  if (!signal || !signal.entryPrice) return;

  const entryPrice = signal.entryPrice;
  const currentMultiple = currentPrice / entryPrice;
  
  // Calculate Drawdown (simplistic: from entry. PRD says min(Pt)/P0 - 1)
  // To do this accurately we need min price history.
  // For v1, we can just update max drawdown if current price is lower than ever seen?
  // Or query min price from samples?
  // Let's query min price from samples efficiently or just track it incrementally if we had it.
  // We'll query aggregate for now.
  const agg = await prisma.priceSample.aggregate({
    where: { signalId },
    _min: { price: true },
    _max: { price: true }
  });
  
  const minPrice = agg._min.price || currentPrice;
  const maxPrice = agg._max.price || currentPrice;
  
  const maxDrawdown = (minPrice / entryPrice) - 1; // negative %
  const athPrice = maxPrice;
  const athMultiple = athPrice / entryPrice;
  const athAt = new Date(); // Approximation if we don't store time of max in agg. 
  // Ideally we find the sample with max price.
  
  // Update Metrics Table
  await prisma.signalMetric.upsert({
    where: { signalId },
    create: {
      signalId,
      currentPrice,
      currentMultiple,
      athPrice,
      athMultiple,
      athAt: new Date(),
      maxDrawdown,
    },
    update: {
      currentPrice,
      currentMultiple,
      athPrice,
      athMultiple,
      maxDrawdown, // Update constantly
      updatedAt: new Date(),
    }
  });

  // Check Thresholds
  for (const k of THRESHOLDS) {
    if (currentMultiple >= k) {
      // Check if already hit
      const existing = await prisma.thresholdEvent.findUnique({
        where: {
          signalId_multipleThreshold: {
            signalId,
            multipleThreshold: k
          }
        }
      });

      if (!existing) {
        // Record Event
        await prisma.thresholdEvent.create({
          data: {
            signalId,
            multipleThreshold: k,
            hitPrice: currentPrice,
            hitAt: new Date(),
            provider: 'helius'
          }
        });

        // Notify
        await notifyThreshold(signal, k, currentPrice);
      }
    }
  }
};

const notifyThreshold = async (signal: any, multiple: number, price: number) => {
  try {
    const bot = getBotInstance();
    const message = `
🚀 *${multiple}x HIT!* 🚀

*Token:* ${signal.name} (${signal.symbol})
*Mint:* \`${signal.mint}\`
*Entry:* $${signal.entryPrice?.toFixed(6)}
*Current:* $${price.toFixed(6)} (${multiple.toFixed(1)}x)

[View on Solscan](https://solscan.io/token/${signal.mint})
`;

    await bot.telegram.sendMessage(Number(signal.chatId), message, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '📈 Chart', callback_data: `chart:${signal.id}` }],
        ]
      }
    });
  } catch (err) {
    logger.error(`Failed to notify threshold for ${signal.id}`, err);
  }
};




