import { prisma } from '../db';
import { logger } from '../utils/logger';
import { getBotInstance } from '../bot/instance';

const THRESHOLDS = [2, 3, 4, 5, 10];

export const updateSignalMetrics = async (signalId: number, currentMarketCap: number | null, currentPrice: number) => {
  const signal = await prisma.signal.findUnique({
    where: { id: signalId },
    include: { metrics: true }
  });

  if (!signal) return;

  // Use market cap for calculations (preferred), fallback to price if market cap not available
  const entryMarketCap = signal.entryMarketCap;
  const entryPrice = signal.entryPrice;
  
  // Prefer market cap-based calculations
  let currentMultiple = 0;
  if (entryMarketCap && currentMarketCap) {
    currentMultiple = currentMarketCap / entryMarketCap;
  } else if (entryPrice && currentPrice) {
    // Fallback to price if market cap not available
    currentMultiple = currentPrice / entryPrice;
  } else {
    return; // Can't calculate without entry data
  }
  
  // Calculate Drawdown using market cap (preferred) or price (fallback)
  // Query min/max market cap from samples
  const agg = await prisma.priceSample.aggregate({
    where: { signalId },
    _min: { marketCap: true, price: true },
    _max: { marketCap: true, price: true }
  });
  
  // Use market cap if available, otherwise fallback to price
  const useMarketCap = entryMarketCap && currentMarketCap && agg._max.marketCap;
  const minValue = useMarketCap ? (agg._min.marketCap || currentMarketCap) : (agg._min.price || currentPrice);
  const maxValue = useMarketCap ? (agg._max.marketCap || currentMarketCap) : (agg._max.price || currentPrice);
  const entryValue = useMarketCap ? entryMarketCap : entryPrice!;
  
  const maxDrawdown = (minValue / entryValue) - 1; // negative %
  const athValue = maxValue || 0;
  const athMultiple = entryValue > 0 ? athValue / entryValue : 0;
  
  const samples = await prisma.priceSample.findMany({
    where: { signalId },
    orderBy: { sampledAt: 'asc' }
  });

  // Find the actual timestamp of ATH from price samples (using market cap if available)
  const athSample = useMarketCap
    ? samples.filter(s => s.marketCap !== null).sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0))[0]
    : samples.sort((a, b) => b.price - a.price)[0];
  const athAt = athSample?.sampledAt || new Date();
  
  // Calculate timeToAth if we have detectedAt
  let timeToAth = null;
  if (signal.detectedAt && athSample) {
    timeToAth = athSample.sampledAt.getTime() - signal.detectedAt.getTime();
  }
  
  // Calculate stagnation time and drawdown duration
  let stagnationTime: number | null = null;
  let drawdownDuration: number | null = null;
  
  if (signal.detectedAt) {
    // Stagnation: time spent < 1.1x before first pump (>1.1x)
    let firstPumpTime: Date | null = null;
    for (const sample of samples) {
      const sampleValue = useMarketCap ? (sample.marketCap || 0) : sample.price;
      const sampleMultiple = entryValue > 0 ? sampleValue / entryValue : 0;
      if (sampleMultiple >= 1.1) {
        firstPumpTime = sample.sampledAt;
        break;
      }
    }
    
    if (firstPumpTime) {
      stagnationTime = firstPumpTime.getTime() - signal.detectedAt.getTime();
    }
    
    // Drawdown duration: time spent underwater (< entry) before ATH
    if (athSample) {
      let underwaterStart: Date | null = null;
      let underwaterEnd: Date | null = null;
      let maxUnderwaterDuration = 0;
      
      for (const sample of samples) {
        const sampleValue = useMarketCap ? (sample.marketCap || 0) : sample.price;
        const sampleMultiple = entryValue > 0 ? sampleValue / entryValue : 0;
        
        if (sampleMultiple < 1.0) {
          if (!underwaterStart) {
            underwaterStart = sample.sampledAt;
          }
          underwaterEnd = sample.sampledAt;
        } else {
          if (underwaterStart && underwaterEnd) {
            const duration = underwaterEnd.getTime() - underwaterStart.getTime();
            if (duration > maxUnderwaterDuration) {
              maxUnderwaterDuration = duration;
            }
          }
          underwaterStart = null;
          underwaterEnd = null;
        }
      }
      
      if (maxUnderwaterDuration > 0) {
        drawdownDuration = maxUnderwaterDuration;
      }
    }
  }
  
  // Update Metrics Table
  const createData: any = {
    signalId,
    currentPrice,
    currentMarketCap: currentMarketCap || null,
    currentMultiple,
    athMultiple,
    athAt,
    maxDrawdown,
    timeToAth: timeToAth || null,
    stagnationTime: stagnationTime || null,
    drawdownDuration: drawdownDuration || null,
  };
  
  if (useMarketCap) {
    createData.athMarketCap = athValue || null;
  } else {
    createData.athPrice = athValue || 0;
  }

  const updateData: any = {
    currentPrice,
    currentMarketCap: currentMarketCap || null,
    currentMultiple,
    athMultiple,
    athAt,
    maxDrawdown,
    timeToAth: timeToAth || null,
    stagnationTime: stagnationTime || null,
    drawdownDuration: drawdownDuration || null,
    updatedAt: new Date(),
  };
  
  if (useMarketCap) {
    updateData.athMarketCap = athValue || null;
  } else {
    updateData.athPrice = athValue || 0;
  }

  await prisma.signalMetric.upsert({
    where: { signalId },
    create: createData,
    update: updateData
  });

  // Check Thresholds (using market cap multiple)
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
        const hitSample = samples.find(sample => {
          const sampleValue = useMarketCap ? (sample.marketCap || 0) : sample.price;
          const sampleMultiple = entryValue > 0 ? sampleValue / entryValue : 0;
          return sampleMultiple >= k;
        });
        const hitAt = hitSample?.sampledAt || new Date();
        
        // Record Event (with market cap)
        await prisma.thresholdEvent.create({
          data: {
            signalId,
            multipleThreshold: k,
            hitPrice: hitSample?.price || currentPrice,
            hitMarketCap: hitSample?.marketCap || currentMarketCap,
            hitAt,
            provider: 'helius'
          }
        });

        // Calculate time to threshold (in milliseconds)
        const timeToThreshold = signal.detectedAt 
          ? hitAt.getTime() - signal.detectedAt.getTime() 
          : null;

        // Update time metrics based on threshold
        const updateData: any = {};
        if (k === 2 && timeToThreshold !== null) {
          updateData.timeTo2x = timeToThreshold;
        } else if (k === 3 && timeToThreshold !== null) {
          updateData.timeTo3x = timeToThreshold;
        } else if (k === 5 && timeToThreshold !== null) {
          updateData.timeTo5x = timeToThreshold;
        } else if (k === 10 && timeToThreshold !== null) {
          updateData.timeTo10x = timeToThreshold;
        }

        // Also update timeToAth if this is a new ATH
        if (currentMultiple >= athMultiple && signal.detectedAt) {
          updateData.timeToAth = timeToThreshold;
        }

        if (Object.keys(updateData).length > 0) {
          await prisma.signalMetric.update({
            where: { signalId },
            data: updateData
          });
        }

        // Notify (using market cap multiple in message)
        await notifyThreshold(signal, k, currentPrice, currentMarketCap, currentMultiple);
      }
    }
  }
};

const notifyThreshold = async (signal: any, multiple: number, price: number, marketCap: number | null, mcapMultiple: number) => {
  try {
    const bot = getBotInstance();
    const entryMc = signal.entryMarketCap ? `$${(signal.entryMarketCap / 1000).toFixed(1)}k` : 'N/A';
    const currentMc = marketCap ? `$${(marketCap / 1000).toFixed(1)}k` : 'N/A';
    const message = `
🚀 *${multiple}x HIT!* 🚀

*Token:* ${signal.name} (${signal.symbol})
*Mint:* \`${signal.mint}\`
*Entry MC:* ${entryMc}
*Current MC:* ${currentMc} (${mcapMultiple.toFixed(1)}x)

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











