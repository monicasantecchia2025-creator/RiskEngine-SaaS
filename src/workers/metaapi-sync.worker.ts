import { AccountStatus, JobType } from '@prisma/client';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { lockNextJob, completeJob, failJob, enqueueJob } from '../services/job.service';
import { metaApiService } from '../services/metaapi.service';

const workerId = `metaapi-sync-${process.pid}`;

function todayUtc() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

async function tick() {
  const job = await lockNextJob(JobType.METAAPI_SYNC, workerId);
  if (!job) return;

  try {
    if (!job.accountId) throw new Error('Job has no accountId');

    const account = await prisma.account.findUniqueOrThrow({ where: { id: job.accountId } });
    if (account.status !== AccountStatus.ACTIVE) {
      await completeJob(job.id);
      return;
    }

    const sync = await metaApiService.syncAccount(account.metaapiAccountId);
    if (!sync.connected) {
      await prisma.account.update({
        where: { id: account.id },
        data: { status: AccountStatus.DISCONNECTED, disconnectedAt: new Date(), pauseReason: 'MetaApi disconnected' }
      });
      await completeJob(job.id);
      return;
    }

    const day = todayUtc();
    await prisma.dailyMetrics.upsert({
      where: { accountId_date: { accountId: account.id, date: day } },
      create: {
        accountId: account.id,
        date: day,
        equity: sync.equity,
        balance: sync.balance,
        dailyPnl: sync.pnl,
        drawdown: 0,
        tradesCount: sync.deals.length
      },
      update: {
        equity: sync.equity,
        balance: sync.balance,
        dailyPnl: sync.pnl,
        tradesCount: sync.deals.length
      }
    });

    for (const deal of sync.deals) {
      await prisma.deal.upsert({
        where: { accountId_providerDealId: { accountId: account.id, providerDealId: String(deal.id) } },
        create: {
          accountId: account.id,
          providerDealId: String(deal.id),
          symbol: deal.symbol ?? 'UNKNOWN',
          volume: Number(deal.volume ?? 0),
          side: deal.type ?? 'UNKNOWN',
          entryPrice: Number(deal.price ?? 0),
          closePrice: null,
          pnl: Number(deal.profit ?? 0),
          executedAt: deal.doneTime ? new Date(deal.doneTime) : new Date(),
          raw: deal as any
        },
        update: {
          pnl: Number(deal.profit ?? 0),
          raw: deal as any
        }
      });
    }

    await enqueueJob(JobType.METAAPI_SYNC, account.id, { reason: 'periodic' });
    await completeJob(job.id);
  } catch (error: any) {
    await failJob(job.id, job.attempts, job.maxAttempts, error.message);
    logger.error({ error }, 'metaapi sync job failed');
  }
}

async function bootstrap() {
  const activeAccounts = await prisma.account.findMany({ where: { status: AccountStatus.ACTIVE } });
  for (const account of activeAccounts) {
    await enqueueJob(JobType.METAAPI_SYNC, account.id, { reason: 'bootstrap' });
  }
}

bootstrap().catch((error) => logger.error({ error }, 'metaapi bootstrap failed'));
setInterval(tick, env.WORKER_POLL_MS);
logger.info({ workerId }, 'metaapi-sync worker started');
