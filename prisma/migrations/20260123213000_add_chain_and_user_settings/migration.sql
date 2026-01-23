-- Add chain column to signals
ALTER TABLE "signals"
ADD COLUMN "chain" TEXT NOT NULL DEFAULT 'solana';

-- Create user_settings table
CREATE TABLE "user_settings" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "preferredChain" TEXT NOT NULL DEFAULT 'both',
    "showRiskScores" BOOLEAN NOT NULL DEFAULT true,
    "showSmartAlerts" BOOLEAN NOT NULL DEFAULT true,
    "compactMode" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "user_settings_pkey" PRIMARY KEY ("id")
);

-- Unique index on user_id
CREATE UNIQUE INDEX "user_settings_user_id_key" ON "user_settings"("user_id");

-- Foreign key to users
ALTER TABLE "user_settings"
ADD CONSTRAINT "user_settings_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

