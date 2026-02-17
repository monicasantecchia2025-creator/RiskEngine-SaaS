ALTER TABLE "Account"
  ADD COLUMN "brokerLogin" TEXT,
  ADD COLUMN "brokerServer" TEXT,
  ADD COLUMN "brokerName" TEXT,
  ADD COLUMN "provisionedBy" TEXT NOT NULL DEFAULT 'existing_metaapi';

CREATE INDEX "Account_provisionedBy_idx" ON "Account"("provisionedBy");
