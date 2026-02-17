import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { buildPreventiveAlerts } from './compliance';

function toYmd(date: Date) {
  return date.toISOString().slice(0, 10);
}

export async function dashboardRoutes(app: FastifyInstance) {
  app.get('/dashboard/overview', { preHandler: [app.authenticate] }, async (request) => {
    const userId = request.authUser!.userId;

    const [accounts, subscriptions, riskEvents] = await Promise.all([
      prisma.account.findMany({ where: { userId }, include: { dailyMetrics: { orderBy: { date: 'desc' }, take: 1 } } }),
      prisma.subscription.findMany({ where: { userId }, orderBy: { updatedAt: 'desc' } }),
      prisma.riskEvent.findMany({ where: { account: { userId } }, orderBy: { createdAt: 'desc' }, take: 20 })
    ]);

    const totalEquity = accounts.reduce((acc, a) => acc + (a.dailyMetrics[0]?.equity ?? 0), 0);
    const totalBalance = accounts.reduce((acc, a) => acc + (a.dailyMetrics[0]?.balance ?? 0), 0);
    const totalDailyPnl = accounts.reduce((acc, a) => acc + (a.dailyMetrics[0]?.dailyPnl ?? 0), 0);

    return {
      accounts: {
        total: accounts.length,
        active: accounts.filter((a) => a.status === 'ACTIVE').length,
        pausedSubscription: accounts.filter((a) => a.status === 'PAUSED_SUBSCRIPTION').length,
        pausedRisk: accounts.filter((a) => a.status === 'PAUSED_RISK').length,
        disconnected: accounts.filter((a) => a.status === 'DISCONNECTED').length
      },
      subscription: subscriptions[0]
        ? {
            status: subscriptions[0].status,
            currentPeriodEnd: subscriptions[0].currentPeriodEnd,
            stripeCustomerId: subscriptions[0].stripeCustomerId,
            stripeSubscriptionId: subscriptions[0].stripeSubscriptionId
          }
        : null,
      kpis: {
        totalEquity,
        totalBalance,
        totalDailyPnl,
        totalOpenRiskAlerts: riskEvents.length
      },
      latestRiskEvents: riskEvents.map((e) => ({
        accountId: e.accountId,
        ruleKey: e.ruleKey,
        severity: e.severity,
        message: e.message,
        actionType: e.actionType,
        createdAt: e.createdAt
      }))
    };
  });

  app.get('/dashboard/accounts/:id/summary', { preHandler: [app.authenticate] }, async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const account = await prisma.account.findFirstOrThrow({
      where: { id: params.id, userId: request.authUser!.userId },
      include: {
        tradingPlan: true,
        subscription: true
      }
    });

    const [latestMetrics, bestDay, worstDay, recentMetrics, recentDeals, riskEvents, auditLogs] = await Promise.all([
      prisma.dailyMetrics.findFirst({ where: { accountId: account.id }, orderBy: { date: 'desc' } }),
      prisma.dailyMetrics.findFirst({ where: { accountId: account.id }, orderBy: { dailyPnl: 'desc' } }),
      prisma.dailyMetrics.findFirst({ where: { accountId: account.id }, orderBy: { dailyPnl: 'asc' } }),
      prisma.dailyMetrics.findMany({ where: { accountId: account.id }, orderBy: { date: 'asc' }, take: 90 }),
      prisma.deal.findMany({ where: { accountId: account.id }, orderBy: { executedAt: 'desc' }, take: 100 }),
      prisma.riskEvent.findMany({ where: { accountId: account.id }, orderBy: { createdAt: 'desc' }, take: 50 }),
      prisma.auditLog.findMany({ where: { accountId: account.id }, orderBy: { createdAt: 'desc' }, take: 50 })
    ]);

    const totalPnl = recentDeals.reduce((acc, d) => acc + d.pnl, 0);
    const wins = recentDeals.filter((d) => d.pnl > 0);
    const losses = recentDeals.filter((d) => d.pnl < 0);
    const winRate = recentDeals.length ? (wins.length / recentDeals.length) * 100 : 0;
    const avgWin = wins.length ? wins.reduce((acc, d) => acc + d.pnl, 0) / wins.length : 0;
    const avgLoss = losses.length ? losses.reduce((acc, d) => acc + d.pnl, 0) / losses.length : 0;
    const profitFactor = Math.abs(avgLoss) > 0 ? Math.abs((wins.reduce((acc, d) => acc + d.pnl, 0) || 0) / (losses.reduce((acc, d) => acc + d.pnl, 0) || -1)) : null;

    const riskBySeverity = riskEvents.reduce(
      (acc, e) => {
        acc[e.severity] = (acc[e.severity] ?? 0) + 1;
        return acc;
      },
      {} as Record<string, number>
    );

    const pnlSeries = recentMetrics.map((m) => ({ date: toYmd(m.date), dailyPnl: m.dailyPnl, equity: m.equity, balance: m.balance, drawdown: m.drawdown }));

    return {
      account: {
        id: account.id,
        name: account.name,
        status: account.status,
        platform: account.platform,
        metaapiAccountId: account.metaapiAccountId,
        pauseReason: account.pauseReason,
        riskPausedUntil: account.riskPausedUntil,
        disconnectedAt: account.disconnectedAt,
        createdAt: account.createdAt
      },
      subscription: account.subscription
        ? {
            status: account.subscription.status,
            currentPeriodStart: account.subscription.currentPeriodStart,
            currentPeriodEnd: account.subscription.currentPeriodEnd,
            stripeCustomerId: account.subscription.stripeCustomerId,
            stripeSubscriptionId: account.subscription.stripeSubscriptionId
          }
        : null,
      plan: account.tradingPlan
        ? {
            rules: account.tradingPlan.rules,
            timezone: account.tradingPlan.timezone,
            dailyReset: account.tradingPlan.dailyReset,
            immutableSLTP: account.tradingPlan.immutableSLTP
          }
        : null,
      kpis: {
        equity: latestMetrics?.equity ?? 0,
        balance: latestMetrics?.balance ?? 0,
        dailyPnl: latestMetrics?.dailyPnl ?? 0,
        totalPnl,
        trades: recentDeals.length,
        winRate,
        avgWin,
        avgLoss,
        profitFactor,
        bestDay: bestDay ? { date: toYmd(bestDay.date), pnl: bestDay.dailyPnl } : null,
        worstDay: worstDay ? { date: toYmd(worstDay.date), pnl: worstDay.dailyPnl } : null
      },
      charts: {
        pnlSeries
      },
      risk: {
        totalEvents: riskEvents.length,
        bySeverity: riskBySeverity,
        latest: riskEvents.slice(0, 10).map((e) => ({
          ruleKey: e.ruleKey,
          severity: e.severity,
          message: e.message,
          actionType: e.actionType,
          createdAt: e.createdAt
        }))
      },
      trades: recentDeals.slice(0, 30).map((d) => ({
        providerDealId: d.providerDealId,
        symbol: d.symbol,
        side: d.side,
        volume: d.volume,
        pnl: d.pnl,
        executedAt: d.executedAt
      })),
      auditTrail: auditLogs.map((a) => ({
        action: a.action,
        entityType: a.entityType,
        entityId: a.entityId,
        metadata: a.metadata,
        createdAt: a.createdAt
      }))
    };
  });

  app.get('/dashboard/accounts/:id/compliance-alerts', { preHandler: [app.authenticate] }, async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const account = await prisma.account.findFirstOrThrow({
      where: { id: params.id, userId: request.authUser!.userId },
      include: { tradingPlan: true }
    });

    const latestMetrics = await prisma.dailyMetrics.findFirst({ where: { accountId: account.id }, orderBy: { date: 'desc' } });
    const planRules = ((account.tradingPlan?.rules as any)?.rules ?? []) as Array<{ key: string; value?: unknown; enabled?: boolean }>;

    const compliance = buildPreventiveAlerts({
      rules: planRules,
      dailyPnl: latestMetrics?.dailyPnl ?? 0,
      tradesCount: latestMetrics?.tradesCount ?? 0,
      now: new Date(),
      riskPausedUntil: account.riskPausedUntil
    });

    return {
      accountId: account.id,
      status: account.status,
      pauseReason: account.pauseReason,
      ...compliance
    };
  });

  app.get('/support/accounts/:id/incidents', { preHandler: [app.authenticate] }, async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const account = await prisma.account.findFirstOrThrow({ where: { id: params.id, userId: request.authUser!.userId } });

    const [riskEvents, audits] = await Promise.all([
      prisma.riskEvent.findMany({ where: { accountId: account.id }, orderBy: { createdAt: 'desc' }, take: 100 }),
      prisma.auditLog.findMany({
        where: { accountId: account.id, action: { in: ['risk.day_locked', 'risk.rule_paused', 'risk.daily_reset_reactivated'] } },
        orderBy: { createdAt: 'desc' },
        take: 100
      })
    ]);

    return {
      accountId: account.id,
      incidents: riskEvents.map((event) => ({
        eventId: event.id,
        at: event.createdAt,
        cause: {
          ruleKey: event.ruleKey,
          severity: event.severity,
          message: event.message
        },
        evidence: event.actionPayload,
        action: {
          type: event.actionType,
          description: event.actionType === 'REQUEST_CLOSE_POSITIONS' ? 'Cierre forzado de posiciones' : 'Bloqueo de operativa diaria'
        }
      })),
      auditTrail: audits.map((audit) => ({
        action: audit.action,
        createdAt: audit.createdAt,
        metadata: audit.metadata
      }))
    };
  });

  app.get('/onboarding/daily-discipline', { preHandler: [app.authenticate] }, async (request) => {
    const userId = request.authUser!.userId;
    const [account, subscription] = await Promise.all([
      prisma.account.findFirst({ where: { userId, status: { not: 'DELETED' } }, include: { tradingPlan: true } }),
      prisma.subscription.findFirst({ where: { userId }, orderBy: { updatedAt: 'desc' } })
    ]);

    const checklist = [
      {
        step: 'Suscripción activa',
        completed: Boolean(subscription && ['ACTIVE', 'TRIALING'].includes(subscription.status))
      },
      {
        step: 'Cuenta conectada con broker',
        completed: Boolean(account)
      },
      {
        step: 'Plan diario escrito (compromiso)',
        completed: Boolean((account?.tradingPlan?.rules as any)?.planNarrative)
      },
      {
        step: 'Reglas de riesgo activas',
        completed: Boolean(((account?.tradingPlan?.rules as any)?.rules ?? []).length)
      },
      {
        step: 'Monitoreo 24/7 en ejecución',
        completed: Boolean(account && ['ACTIVE', 'PAUSED_RISK'].includes(account.status))
      }
    ];

    return {
      accountId: account?.id ?? null,
      message: 'Guía diaria para cumplir tu plan de trading sin romper tu palabra.',
      checklist
    };
  });
}
