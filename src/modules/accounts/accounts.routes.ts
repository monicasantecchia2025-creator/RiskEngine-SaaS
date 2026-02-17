import { AccountStatus, JobType, Platform } from '@prisma/client';
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { metaApiService } from '../../services/metaapi.service';
import { tradingPlanSchema } from './trading-plan.schema';
import { enqueueJob } from '../../services/job.service';

const brokerProvisionSchema = z
  .object({
    name: z.string().min(2),
    platform: z.enum(['mt4', 'mt5']),
    brokerLogin: z.string().min(1),
    brokerPassword: z.string().min(1),
    brokerServer: z.string().min(2),
    brokerName: z.string().min(2).optional()
  })
  .strict();

export async function accountRoutes(app: FastifyInstance) {
  app.post('/accounts', { preHandler: [app.authenticate] }, async (request, reply) => {
    const body = brokerProvisionSchema.parse(request.body);
    const userId = request.authUser!.userId;
    const platform = body.platform === 'mt4' ? Platform.MT4 : Platform.MT5;

    const activeSubscription = await prisma.subscription.findFirst({
      where: {
        userId,
        status: { in: ['ACTIVE', 'TRIALING'] }
      },
      orderBy: { updatedAt: 'desc' }
    });

    if (!activeSubscription) {
      const latestSubscription = await prisma.subscription.findFirst({ where: { userId }, orderBy: { updatedAt: 'desc' } });
      return reply.code(402).send({
        message: 'Active subscription required before connecting account.',
        details: latestSubscription
          ? {
              currentStatus: latestSubscription.status,
              stripeCustomerId: latestSubscription.stripeCustomerId,
              stripeSubscriptionId: latestSubscription.stripeSubscriptionId,
              currentPeriodEnd: latestSubscription.currentPeriodEnd
            }
          : { reason: 'No subscription record found for this user.' }
      });
    }

    const usedSlot = await prisma.account.findFirst({
      where: {
        subscriptionId: activeSubscription.id,
        status: { not: 'DELETED' }
      }
    });

    if (usedSlot) {
      return reply.code(409).send({ message: 'Your subscription already has 1 connected account limit.' });
    }

    const created = await metaApiService.createAndConnectAccount({
      accountName: body.name,
      platform,
      login: body.brokerLogin,
      password: body.brokerPassword,
      server: body.brokerServer,
      brokerName: body.brokerName
    });

    const account = await prisma.account.create({
      data: {
        userId,
        subscriptionId: activeSubscription.id,
        name: body.name,
        platform,
        metaapiAccountId: created._id,
        brokerLogin: body.brokerLogin,
        brokerServer: body.brokerServer,
        brokerName: body.brokerName,
        provisionedBy: 'provisioned_in_metaapi',
        status: AccountStatus.PENDING_PLAN
      }
    });

    await prisma.auditLog.create({
      data: {
        actorUserId: userId,
        accountId: account.id,
        action: 'account.created',
        entityType: 'Account',
        entityId: account.id,
        metadata: {
          platform: account.platform,
          metaapiAccountId: account.metaapiAccountId,
          provisionedBy: account.provisionedBy,
          brokerLogin: account.brokerLogin,
          brokerServer: account.brokerServer,
          brokerName: account.brokerName,
          subscriptionId: activeSubscription.id
        }
      }
    });

    await enqueueJob(JobType.METAAPI_SYNC, account.id, { reason: 'initial_sync' });

    return reply.code(201).send(account);
  });

  app.get('/accounts', { preHandler: [app.authenticate] }, async (request) => {
    return prisma.account.findMany({ where: { userId: request.authUser!.userId }, include: { tradingPlan: true, subscription: true } });
  });

  app.get('/accounts/:id', { preHandler: [app.authenticate] }, async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    return prisma.account.findFirstOrThrow({
      where: { id: params.id, userId: request.authUser!.userId },
      include: { tradingPlan: true, subscription: true }
    });
  });

  app.post('/accounts/:id/trading-plan', { preHandler: [app.authenticate] }, async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = tradingPlanSchema.parse(request.body);

    const result = await prisma.$transaction(
      async (tx) => {
        const account = await tx.account.findFirstOrThrow({ where: { id: params.id, userId: request.authUser!.userId }, include: { subscription: true } });
        await tx.account.update({ where: { id: account.id }, data: { updatedAt: new Date() } });

        const existing = await tx.tradingPlan.findUnique({ where: { accountId: account.id } });
        if (existing) throw new Error('TradingPlan already exists and is immutable');

        const plan = await tx.tradingPlan.create({
          data: {
            accountId: account.id,
            rules: body as any,
            timezone: body.timezone,
            dailyReset: body.resetPolicy.dailyReset,
            immutableSLTP: body.executionControls.enforceStopLoss && body.executionControls.enforceTakeProfit
          }
        });

        const subscriptionActive =
          account.subscription &&
          ['ACTIVE', 'TRIALING'].includes(account.subscription.status) &&
          (!account.subscription.currentPeriodEnd || account.subscription.currentPeriodEnd > new Date());

        const newStatus = subscriptionActive ? AccountStatus.ACTIVE : AccountStatus.PAUSED_SUBSCRIPTION;

        await tx.account.update({ where: { id: account.id }, data: { status: newStatus, riskPausedUntil: null } });
        await tx.auditLog.create({
          data: {
            actorUserId: request.authUser!.userId,
            accountId: account.id,
            action: 'trading_plan.created',
            entityType: 'TradingPlan',
            entityId: plan.id,
            metadata: { statusAfterCreate: newStatus }
          }
        });

        if (newStatus === AccountStatus.ACTIVE) {
          await tx.job.createMany({
            data: [
              { accountId: account.id, type: JobType.METAAPI_SYNC },
              { accountId: account.id, type: JobType.RISK_ENGINE_EVAL }
            ]
          });
        }

        return plan;
      },
      { isolationLevel: 'Serializable' }
    );

    return reply.code(201).send(result);
  });
}
