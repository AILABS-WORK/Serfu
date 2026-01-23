import { prisma } from './index';
import { Prisma } from '../generated/client';

export type SignalCreateInput = Prisma.SignalCreateInput;

export const createSignal = async (data: SignalCreateInput) => {
  const signal = await prisma.signal.create({
    data,
  });
  
  // Initialize metrics record with default values when signal is created
  // This ensures all signals have metrics, even if ATH hasn't been calculated yet
  try {
    await prisma.signalMetric.upsert({
      where: { signalId: signal.id },
      create: {
        signalId: signal.id,
        currentPrice: data.entryPrice || 0,
        currentMultiple: 1.0,
        athPrice: data.entryPrice || 0,
        athMultiple: 1.0,
        athMarketCap: data.entryMarketCap || null,
        athAt: signal.detectedAt,
        maxDrawdown: 0,
        timeToAth: null,
        timeTo2x: null,
        timeTo3x: null,
        timeTo5x: null,
        timeTo10x: null,
        stagnationTime: null,
        drawdownDuration: null,
        currentMarketCap: data.entryMarketCap || null,
        updatedAt: new Date()
      },
      update: {} // Don't update if already exists
    });
  } catch (err) {
    // Log but don't fail signal creation if metrics creation fails
    console.error(`Failed to initialize metrics for signal ${signal.id}:`, err);
  }
  
  return signal;
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

