import { prisma } from './index';

export const addPriceSample = async (signalId: number, mint: string, price: number, provider: string) => {
  return prisma.priceSample.create({
    data: {
      signalId,
      mint,
      price,
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




