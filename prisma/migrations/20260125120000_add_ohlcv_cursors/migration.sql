-- Add OHLCV cursor fields for incremental ATH/drawdown updates
ALTER TABLE "signal_metrics"
ADD COLUMN "ohlcv_last_at" TIMESTAMP,
ADD COLUMN "min_low_price" DOUBLE PRECISION,
ADD COLUMN "min_low_at" TIMESTAMP;

