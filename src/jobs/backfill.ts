import { prisma } from '../db';
import { provider } from '../providers';
import { logger } from '../utils/logger';

export const backfillEntryMarketCap = async (targetSignalIds?: number[]) => {
  try {
    const where: any = { entryMarketCap: null };
    if (targetSignalIds && targetSignalIds.length > 0) {
      where.id = { in: targetSignalIds };
    } else {
      where.detectedAt = { gte: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000) };
    }

    const signals = await prisma.signal.findMany({
      where,
      include: { priceSamples: { orderBy: { sampledAt: 'asc' }, take: 1 } },
    });

    for (const signal of signals) {
      let entryMarketCap = signal.priceSamples[0]?.marketCap || null;
      let entrySupply = signal.entrySupply || null;
      let entryPrice = signal.entryPrice || null;

      if (!entryMarketCap) {
        try {
          const meta = await provider.getTokenMeta(signal.mint);
          entrySupply = entrySupply || meta.supply || null;
          const quote = await provider.getQuote(signal.mint);
          entryPrice = entryPrice || quote.price || null;
          if (entryPrice && entrySupply) {
            entryMarketCap = entryPrice * entrySupply;
          } else if (meta.marketCap) {
            entryMarketCap = meta.marketCap;
          }
        } catch (err) {
          logger.debug(`Backfill entry MC failed for ${signal.mint}:`, err);
        }
      }

      if (entryMarketCap) {
        await prisma.signal.update({
          where: { id: signal.id },
          data: {
            entryMarketCap,
            entrySupply,
            entryPrice,
            entryPriceAt: signal.entryPriceAt || new Date(),
            trackingStatus: 'ACTIVE',
          },
        });
      }
    }
  } catch (error) {
    logger.error('Error in backfillEntryMarketCap:', error);
  }
};

export const backfillTokenMeta = async (targetSignalIds?: number[]) => {
  try {
    const where: any = {
      OR: [
        { tokenCreatedAt: null },
        { socials: null },
      ],
    };
    if (targetSignalIds && targetSignalIds.length > 0) {
      where.id = { in: targetSignalIds };
    } else {
      where.detectedAt = { gte: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000) };
    }

    const signals = await prisma.signal.findMany({ where });
    for (const signal of signals) {
      try {
        const meta = await provider.getTokenMeta(signal.mint);
        const tokenCreatedAt = meta.createdAt || meta.firstPoolCreatedAt || null;
        const socials = meta.socialLinks || undefined;
        const entrySupply = signal.entrySupply || meta.supply || null;

        await prisma.signal.update({
          where: { id: signal.id },
          data: {
            tokenCreatedAt: tokenCreatedAt || signal.tokenCreatedAt,
            socials: socials || signal.socials || undefined,
            entrySupply,
          },
        });
      } catch (err) {
        logger.debug(`Backfill token meta failed for ${signal.mint}:`, err);
      }
    }
  } catch (error) {
    logger.error('Error in backfillTokenMeta:', error);
  }
};

