import { AccountStatus, JobType } from '@prisma/client';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { completeJob, failJob, lockNextJob, enqueueJob } from '../services/job.service';
import { metaApiService } from '../services/metaapi.service';

const workerId = `subscription-expiry-${process.pid}`;

async function pauseForSubscription(accountId: string, metaapiAccountId: string) {
  await prisma.account.update({
    where: { id: accountId },
    data: { status: AccountStatus.PAUSED_SUBSCRIPTION, pauseReason: 'Subscription inactive/expired' }
  });

  try {
    await metaApiService.pauseAccount(metaapiAccountId);
  } catch (error) {
    logger.warn({ accountId, error }, 'failed to pause account in MetaApi');
  }

  await prisma.auditLog.create({
    data: {
      accountId,
      action: 'subscription.paused_account',
      entityType: 'Account',
      entityId: accountId,
      metadata: { reason: 'Subscription inactive/expired' }
    }
  });
}

async function reactivateForSubscription(accountId: string, metaapiAccountId: string) {
  await prisma.account.update({
    where: { id: accountId },
    data: { status: AccountStatus.ACTIVE, pauseReason: null, disconnectedAt: null }
  });

  try {
    await metaApiService.resumeAccount(metaapiAccountId);
  } catch (error) {
    logger.warn({ accountId, error }, 'failed to resume account in MetaApi');
  }

  await prisma.auditLog.create({
    data: {
      accountId,
      action: 'subscription.reactivated_account',
      entityType: 'Account',
      entityId: accountId,
      metadata: { reason: 'Subscription active again' }
    }
  });

  await enqueueJob(JobType.METAAPI_SYNC, accountId, { reason: 'subscription_reactivated' });
  await enqueueJob(JobType.RISK_ENGINE_EVAL, accountId, { reason: 'subscription_reactivated' });
}

async function tick() {
  const job = await lockNextJob(JobType.SUBSCRIPTION_EXPIRY, workerId);
  if (!job) return;

  try {
    const now = new Date();
    const accounts = await prisma.account.findMany({ include: { subscription: true, tradingPlan: true } });

    for (const account of accounts) {
      const active =
        account.subscription &&
        ['ACTIVE', 'TRIALING'].includes(account.subscription.status) &&
        (!account.subscription.currentPeriodEnd || account.subscription.currentPeriodEnd > now);

      if (!active && account.status === AccountStatus.ACTIVE) {
        await pauseForSubscription(account.id, account.metaapiAccountId);
      }

      if (active && account.status === AccountStatus.PAUSED_SUBSCRIPTION && account.tradingPlan) {
        await reactivateForSubscription(account.id, account.metaapiAccountId);
      }
    }

    await enqueueJob(JobType.SUBSCRIPTION_EXPIRY, undefined, { reason: 'periodic' });
    await completeJob(job.id);
  } catch (error: any) {
    await failJob(job.id, job.attempts, job.maxAttempts, error.message);
    logger.error({ error }, 'subscription expiry worker failed');
  }
}

enqueueJob(JobType.SUBSCRIPTION_EXPIRY, undefined, { reason: 'bootstrap' }).catch((error) =>
  logger.error({ error }, 'subscription bootstrap failed')
);

setInterval(tick, env.WORKER_POLL_MS);
logger.info({ workerId }, 'subscription-expiry worker started');
