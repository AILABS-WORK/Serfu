import { prisma } from './index';

export const addPriceSample = async (signalId: number, mint: string, price: number, provider: string, marketCap?: number | null) => {
  return prisma.priceSample.create({
    data: {
      signalId,
      mint,
      price,
      marketCap: marketCap ?? null,
      provider,
      sampledAt: new Date(),
    },
  });
};

export const getLatestSample = async (signalId: number) => {
  return prisma.priceSample.findFirst({
    where: { signalId },
    orderBy: { sampledAt: 'desc' },
  });
};











