import { prisma } from './index';
import { Prisma } from '../generated/client/client';

export type SignalCreateInput = Prisma.SignalCreateInput;

export const createSignal = async (data: SignalCreateInput) => {
  return prisma.signal.create({
    data,
  });
};

export const getSignalByMint = async (mint: string) => {
  return prisma.signal.findFirst({
    where: { mint },
    orderBy: { detectedAt: 'desc' },
  });
};

export const getActiveSignals = async () => {
  return prisma.signal.findMany({
    where: { trackingStatus: 'ACTIVE' },
  });
};

export const updateSignalStatus = async (id: number, status: 'ACTIVE' | 'ARCHIVED' | 'ENTRY_PENDING') => {
  return prisma.signal.update({
    where: { id },
    data: { trackingStatus: status },
  });
};

export const updateEntryPrice = async (id: number, price: number, provider: string) => {
  return prisma.signal.update({
    where: { id },
    data: { 
      entryPrice: price,
      entryPriceAt: new Date(),
      entryPriceProvider: provider,
      trackingStatus: 'ACTIVE' // Activate if it was pending
    },
  });
};

