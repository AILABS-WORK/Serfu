import { SignalMetric } from '../generated/client';

export const getEntryTime = (signal: { entryPriceAt?: Date | null; detectedAt?: Date | null }): Date | null => {
  return signal.entryPriceAt ?? signal.detectedAt ?? null;
};

export const getEntryTimeMs = (signal: { entryPriceAt?: Date | null; detectedAt?: Date | null }): number | null => {
  const entryTime = getEntryTime(signal);
  return entryTime ? entryTime.getTime() : null;
};

export const hasComputedAth = (metrics?: SignalMetric | null): boolean => {
  return !!metrics && metrics.athPrice > 0 && metrics.athMultiple > 0 && !!metrics.athAt;
};

export const hasComputedDrawdown = (metrics?: SignalMetric | null): boolean => {
  return !!metrics && metrics.maxDrawdown !== null && metrics.maxDrawdown !== undefined;
};

export const hasComputedTimes = (metrics?: SignalMetric | null): boolean => {
  return !!metrics && metrics.timeToAth !== null && metrics.timeToAth !== undefined;
};

