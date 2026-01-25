-- Add time_to_drawdown for max drawdown timestamp from entry
ALTER TABLE "signal_metrics"
ADD COLUMN "time_to_drawdown" INTEGER;

