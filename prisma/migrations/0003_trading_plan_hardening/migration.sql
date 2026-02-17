-- AlterTable
ALTER TABLE "Account" ADD COLUMN "riskPausedUntil" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "TradingPlan" ADD COLUMN "dailyReset" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "immutableSLTP" BOOLEAN NOT NULL DEFAULT true;
