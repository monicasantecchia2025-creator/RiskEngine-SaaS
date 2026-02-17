import { AccountStatus, JobType } from '@prisma/client';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { completeJob, failJob, lockNextJob, enqueueJob } from '../services/job.service';
import { evaluateRules } from '../modules/risk/rule-engine';
import { metaApiService } from '../services/metaapi.service';

const workerId = `risk-engine-${process.pid}`;

function nextUtcDay(now: Date) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

async function tick() {
  const job = await lockNextJob(JobType.RISK_ENGINE_EVAL, workerId);
  if (!job) return;

  try {
    if (!job.accountId) throw new Error('Job missing accountId');

    const account = await prisma.account.findUniqueOrThrow({ where: { id: job.accountId }, include: { tradingPlan: true } });
    if (!account.tradingPlan) {
      await completeJob(job.id);
      return;
    }

    const now = new Date();
    if (account.status === AccountStatus.PAUSED_RISK) {
      await prisma.account.update({
        where: { id: account.id },
        data: { status: AccountStatus.ACTIVE }
      });
      account.status = AccountStatus.ACTIVE;
    }

    if (account.riskPausedUntil && account.riskPausedUntil <= now && account.tradingPlan.dailyReset) {
      await prisma.account.update({
        where: { id: account.id },
        data: { pauseReason: null, riskPausedUntil: null }
      });
      await prisma.auditLog.create({
        data: {
          accountId: account.id,
          action: 'risk.daily_reset_reactivated',
          entityType: 'Account',
          entityId: account.id,
          metadata: { previousPauseReason: account.pauseReason }
        }
      });
      account.pauseReason = null;
      account.riskPausedUntil = null;
    }

    if (account.status !== AccountStatus.ACTIVE) {
      await completeJob(job.id);
      return;
    }

    if (account.riskPausedUntil && account.riskPausedUntil > now) {
      try {
        await metaApiService.requestClosePositions(account.metaapiAccountId);
      } catch (error) {
        logger.warn({ accountId: account.id, error }, 'failed to enforce daily lock with close positions');
      }

      await enqueueJob(JobType.RISK_ENGINE_EVAL, account.id, { reason: 'daily_lock_enforcement' });
      await completeJob(job.id);
      return;
    }

    const deals = await prisma.deal.findMany({ where: { accountId: account.id }, orderBy: { executedAt: 'desc' }, take: 2000 });
    const metrics = await prisma.dailyMetrics.findFirst({ where: { accountId: account.id }, orderBy: { date: 'desc' } });
    const violations = evaluateRules({ account, plan: account.tradingPlan, deals, metrics, now });

    for (const violation of violations) {
      await prisma.riskEvent.create({
        data: {
          accountId: account.id,
          ruleKey: violation.rule.key,
          severity: violation.result.severity ?? 'warning',
          message: violation.result.message ?? 'Rule violated',
          actionType: violation.result.actionType ?? 'NOTIFY',
          actionPayload: { rule: violation.rule, result: violation.result } as any
        }
      });

      if (violation.rule.key === 'require_stop_loss_take_profit') {
        const payload = (violation.result.payload ?? {}) as {
          missingDeals?: Array<{ providerDealId: string; entryPrice: number; raw?: Record<string, unknown> }>;
          slTpUnit?: 'percent' | 'money';
          stopLossValue?: number;
          takeProfitValue?: number;
        };

        const missingDeals = payload.missingDeals ?? [];
        const slTpUnit = payload.slTpUnit ?? 'percent';
        const stopLossValue = Number(payload.stopLossValue ?? 0);
        const takeProfitValue = Number(payload.takeProfitValue ?? 0);

        for (const deal of missingDeals) {
          const positionId = String((deal.raw?.positionId as string | undefined) ?? deal.providerDealId);
          if (!positionId || !deal.entryPrice || stopLossValue <= 0 || takeProfitValue <= 0) continue;

          try {
            await metaApiService.applyStopLossTakeProfit({
              metaapiAccountId: account.metaapiAccountId,
              positionId,
              entryPrice: deal.entryPrice,
              slTpUnit,
              stopLossValue,
              takeProfitValue
            });
          } catch (error) {
            logger.warn({ accountId: account.id, positionId, error }, 'failed to auto-apply SL/TP from plan');
          }
        }

        await prisma.auditLog.create({
          data: {
            accountId: account.id,
            action: 'risk.auto_apply_sltp',
            entityType: 'Account',
            entityId: account.id,
            metadata: {
              missingDeals: missingDeals.length,
              slTpUnit,
              stopLossValue,
              takeProfitValue
            }
          }
        });
      }

      if (violation.result.actionType === 'PAUSE_ACCOUNT') {
        const lockUntil = violation.result.lockUntilNextDay ? nextUtcDay(now) : null;
        await prisma.account.update({
          where: { id: account.id },
          data: {
            pauseReason: violation.result.message ?? 'Risk violation',
            riskPausedUntil: lockUntil
          }
        });

        await prisma.auditLog.create({
          data: {
            accountId: account.id,
            action: violation.result.lockUntilNextDay ? 'risk.day_locked' : 'risk.rule_paused',
            entityType: 'Account',
            entityId: account.id,
            metadata: {
              ruleKey: violation.rule.key,
              message: violation.result.message,
              lockUntil
            }
          }
        });

        if (violation.result.lockUntilNextDay) {
          try {
            await metaApiService.requestClosePositions(account.metaapiAccountId);
          } catch (error) {
            logger.warn({ accountId: account.id, error }, 'failed to close positions after daily lock');
          }
        }
      }

      if (violation.result.actionType === 'REQUEST_CLOSE_POSITIONS') {
        await metaApiService.requestClosePositions(account.metaapiAccountId);
      }

      await prisma.outboxEvent.create({
        data: {
          accountId: account.id,
          topic: 'risk.violation',
          payload: {
            ruleKey: violation.rule.key,
            message: violation.result.message,
            actionType: violation.result.actionType,
            lockUntilNextDay: violation.result.lockUntilNextDay ?? false
          } as any
        }
      });

      await prisma.outboxEvent.create({
        data: {
          accountId: account.id,
          topic: 'notifications.multichannel',
          payload: {
            channels: ['in_app', 'email', 'telegram'],
            title: 'Alerta de cumplimiento del plan',
            message: violation.result.message ?? 'Se detectó una violación del plan diario.',
            metadata: {
              ruleKey: violation.rule.key,
              severity: violation.result.severity ?? 'warning',
              actionType: violation.result.actionType
            }
          } as any
        }
      });
    }

    await enqueueJob(JobType.RISK_ENGINE_EVAL, account.id, { reason: 'periodic' });
    await completeJob(job.id);
  } catch (error: any) {
    await failJob(job.id, job.attempts, job.maxAttempts, error.message);
    logger.error({ error }, 'risk engine job failed');
  }
}

async function bootstrap() {
  const activeAccounts = await prisma.account.findMany({ where: { status: { in: [AccountStatus.ACTIVE, AccountStatus.PAUSED_RISK] } } });
  for (const account of activeAccounts) {
    await enqueueJob(JobType.RISK_ENGINE_EVAL, account.id, { reason: 'bootstrap' });
  }
}

bootstrap().catch((error) => logger.error({ error }, 'risk bootstrap failed'));
setInterval(tick, Math.max(250, env.RISK_ENGINE_POLL_MS));
logger.info({ workerId }, 'risk-engine worker started');
