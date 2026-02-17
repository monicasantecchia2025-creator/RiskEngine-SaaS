-- Initial schema for Risk Engine SaaS
CREATE TYPE "SubscriptionStatus" AS ENUM ('INCOMPLETE','INCOMPLETE_EXPIRED','TRIALING','ACTIVE','PAST_DUE','CANCELED','UNPAID','PAUSED');
CREATE TYPE "AccountStatus" AS ENUM ('PENDING_PLAN','ACTIVE','PAUSED_SUBSCRIPTION','PAUSED_RISK','DISCONNECTED','DELETED');
CREATE TYPE "Platform" AS ENUM ('MT4','MT5');
CREATE TYPE "RiskActionType" AS ENUM ('PAUSE_ACCOUNT','REQUEST_CLOSE_POSITIONS','NOTIFY');
CREATE TYPE "JobType" AS ENUM ('METAAPI_SYNC','RISK_ENGINE_EVAL','SUBSCRIPTION_EXPIRY');
CREATE TYPE "JobStatus" AS ENUM ('PENDING','RUNNING','DONE','FAILED');

CREATE TABLE "User" (
  "id" TEXT PRIMARY KEY,
  "email" TEXT NOT NULL UNIQUE,
  "passwordHash" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "role" TEXT NOT NULL DEFAULT 'user',
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMP NOT NULL
);

CREATE TABLE "Subscription" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "provider" TEXT NOT NULL DEFAULT 'stripe',
  "stripeCustomerId" TEXT NOT NULL UNIQUE,
  "stripeSubscriptionId" TEXT UNIQUE,
  "stripePriceId" TEXT,
  "status" "SubscriptionStatus" NOT NULL DEFAULT 'INCOMPLETE',
  "currentPeriodStart" TIMESTAMP,
  "currentPeriodEnd" TIMESTAMP,
  "cancelAt" TIMESTAMP,
  "canceledAt" TIMESTAMP,
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMP NOT NULL
);

CREATE TABLE "Account" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "subscriptionId" TEXT REFERENCES "Subscription"("id") ON DELETE SET NULL,
  "name" TEXT NOT NULL,
  "platform" "Platform" NOT NULL,
  "metaapiAccountId" TEXT NOT NULL UNIQUE,
  "status" "AccountStatus" NOT NULL DEFAULT 'PENDING_PLAN',
  "pauseReason" TEXT,
  "disconnectedAt" TIMESTAMP,
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMP NOT NULL
);

CREATE TABLE "TradingPlan" (
  "id" TEXT PRIMARY KEY,
  "accountId" TEXT NOT NULL UNIQUE REFERENCES "Account"("id") ON DELETE CASCADE,
  "rules" JSONB NOT NULL,
  "timezone" TEXT NOT NULL DEFAULT 'UTC',
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE "Deal" (
  "id" TEXT PRIMARY KEY,
  "accountId" TEXT NOT NULL REFERENCES "Account"("id") ON DELETE CASCADE,
  "providerDealId" TEXT NOT NULL,
  "symbol" TEXT NOT NULL,
  "volume" DOUBLE PRECISION NOT NULL,
  "side" TEXT NOT NULL,
  "entryPrice" DOUBLE PRECISION NOT NULL,
  "closePrice" DOUBLE PRECISION,
  "pnl" DOUBLE PRECISION NOT NULL,
  "executedAt" TIMESTAMP NOT NULL,
  "raw" JSONB,
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE("accountId","providerDealId")
);

CREATE TABLE "DailyMetrics" (
  "id" TEXT PRIMARY KEY,
  "accountId" TEXT NOT NULL REFERENCES "Account"("id") ON DELETE CASCADE,
  "date" TIMESTAMP NOT NULL,
  "equity" DOUBLE PRECISION NOT NULL,
  "balance" DOUBLE PRECISION NOT NULL,
  "dailyPnl" DOUBLE PRECISION NOT NULL,
  "drawdown" DOUBLE PRECISION NOT NULL,
  "tradesCount" INTEGER NOT NULL,
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMP NOT NULL,
  UNIQUE("accountId","date")
);

CREATE TABLE "RiskEvent" (
  "id" TEXT PRIMARY KEY,
  "accountId" TEXT NOT NULL REFERENCES "Account"("id") ON DELETE CASCADE,
  "ruleKey" TEXT NOT NULL,
  "severity" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "actionType" "RiskActionType" NOT NULL,
  "actionPayload" JSONB,
  "evaluatedAt" TIMESTAMP NOT NULL DEFAULT NOW(),
  "resolvedAt" TIMESTAMP,
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE "WebhookEvent" (
  "id" TEXT PRIMARY KEY,
  "provider" TEXT NOT NULL,
  "providerEventId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "signature" TEXT,
  "processedAt" TIMESTAMP,
  "processingError" TEXT,
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE("provider","providerEventId")
);

CREATE TABLE "Job" (
  "id" TEXT PRIMARY KEY,
  "accountId" TEXT REFERENCES "Account"("id") ON DELETE SET NULL,
  "type" "JobType" NOT NULL,
  "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 10,
  "nextRunAt" TIMESTAMP NOT NULL DEFAULT NOW(),
  "lastError" TEXT,
  "lockedAt" TIMESTAMP,
  "lockOwner" TEXT,
  "payload" JSONB,
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMP NOT NULL
);

CREATE TABLE "OutboxEvent" (
  "id" TEXT PRIMARY KEY,
  "accountId" TEXT REFERENCES "Account"("id") ON DELETE SET NULL,
  "topic" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "publishedAt" TIMESTAMP,
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE "AuditLog" (
  "id" TEXT PRIMARY KEY,
  "actorUserId" TEXT REFERENCES "User"("id") ON DELETE SET NULL,
  "accountId" TEXT REFERENCES "Account"("id") ON DELETE SET NULL,
  "action" TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "metadata" JSONB,
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW()
);
