-- Add max drawdown market cap and recovery time fields
ALTER TABLE "signal_metrics"
ADD COLUMN "max_drawdown_market_cap" DOUBLE PRECISION,
ADD COLUMN "time_from_drawdown_to_ath" INTEGER;


