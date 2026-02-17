import { Account, DailyMetrics, Deal, TradingPlan } from '@prisma/client';

export type RuleExecutionContext = {
  account: Account;
  plan: TradingPlan;
  deals: Deal[];
  metrics: DailyMetrics | null;
  now: Date;
};

export type RuleResult = {
  violated: boolean;
  message?: string;
  severity?: 'info' | 'warning' | 'critical';
  actionType?: 'PAUSE_ACCOUNT' | 'REQUEST_CLOSE_POSITIONS' | 'NOTIFY';
  payload?: Record<string, unknown>;
  lockUntilNextDay?: boolean;
};

type RuleHandler = (rule: any, context: RuleExecutionContext) => RuleResult;

type PlanRulesPayload = {
  executionControls?: {
    slTpUnit?: 'percent' | 'money';
    stopLossValue?: number;
    takeProfitValue?: number;
  };
  rules: any[];
};

function nearlyEqual(a: number, b: number, epsilon = 0.15) {
  return Math.abs(a - b) <= epsilon;
}

function parseMoney(raw: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === 'number' && Number.isFinite(value)) return Math.abs(value);
  }
  return null;
}

function brokerTimeParts(now: Date, brokerTimezone: string) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: brokerTimezone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit'
  });

  const parts = formatter.formatToParts(now);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? '0');
  return { hour, minute };
}

const toActionType = (action: string): RuleResult['actionType'] => {
  if (action === 'pause_account') return 'PAUSE_ACCOUNT';
  if (action === 'request_close_positions') return 'REQUEST_CLOSE_POSITIONS';
  return 'NOTIFY';
};

export const ruleRegistry: Record<string, RuleHandler> = {
  max_daily_loss: (rule, ctx) => {
    const dailyPnl = ctx.metrics?.dailyPnl ?? 0;
    const violated = dailyPnl <= rule.value;
    return {
      violated,
      message: violated ? `Daily loss exceeded: ${dailyPnl}` : undefined,
      severity: 'critical',
      actionType: toActionType(rule.action),
      lockUntilNextDay: true
    };
  },
  max_total_loss: (rule, ctx) => {
    const totalPnl = ctx.deals.reduce((acc, d) => acc + d.pnl, 0);
    const violated = totalPnl <= rule.value;
    return { violated, message: violated ? `Total loss exceeded: ${totalPnl}` : undefined, severity: 'critical', actionType: toActionType(rule.action) };
  },
  max_daily_profit_target: (rule, ctx) => {
    const dailyPnl = ctx.metrics?.dailyPnl ?? 0;
    const violated = dailyPnl >= rule.value;
    return {
      violated,
      message: violated ? `Daily target reached: ${dailyPnl}` : undefined,
      severity: 'info',
      actionType: toActionType(rule.action),
      lockUntilNextDay: true
    };
  },
  max_drawdown: (rule, ctx) => {
    const drawdown = ctx.metrics?.drawdown ?? 0;
    const violated = drawdown >= rule.value;
    return { violated, message: violated ? `Max drawdown exceeded: ${drawdown}` : undefined, severity: 'warning', actionType: toActionType(rule.action) };
  },
  max_trades_per_day: (rule, ctx) => {
    const count = ctx.metrics?.tradesCount ?? 0;
    const violated = count >= rule.value;
    return {
      violated,
      message: violated ? `Daily trade limit reached: ${count}/${rule.value}` : undefined,
      severity: 'warning',
      actionType: toActionType(rule.action),
      lockUntilNextDay: true
    };
  },
  allowed_hours: (rule, ctx) => {
    const { hour } = brokerTimeParts(ctx.now, ctx.plan.timezone || 'UTC');
    const violated = hour < rule.value.start || hour > rule.value.end;
    return {
      violated,
      message: violated ? `Outside allowed trading hours (${ctx.plan.timezone}): ${hour}` : undefined,
      severity: 'warning',
      actionType: toActionType(rule.action)
    };
  },
  close_all_at_midnight: (rule, ctx) => {
    const { hour, minute } = brokerTimeParts(ctx.now, ctx.plan.timezone || 'UTC');
    const violated = Boolean(rule.value) && hour === 0 && minute < 5;
    return {
      violated,
      message: violated ? `Close all at midnight triggered (${ctx.plan.timezone})` : undefined,
      severity: 'info',
      actionType: toActionType(rule.action)
    };
  },
  require_stop_loss_take_profit: (rule, ctx) => {
    if (!rule.value) return { violated: false };

    const planPayload = ctx.plan.rules as PlanRulesPayload;
    const controls = planPayload.executionControls;
    const unit = controls?.slTpUnit ?? 'percent';
    const expectedSl = controls?.stopLossValue;
    const expectedTp = controls?.takeProfitValue;

    const missingOrInvalidDeals = ctx.deals.filter((deal) => {
      const raw = (deal.raw ?? {}) as Record<string, unknown>;
      const stopLoss = raw.stopLoss;
      const takeProfit = raw.takeProfit;

      if (stopLoss === null || stopLoss === undefined || takeProfit === null || takeProfit === undefined) {
        return true;
      }

      if (!expectedSl || !expectedTp) return false;

      const entryPrice =
        typeof raw.entryPrice === 'number'
          ? raw.entryPrice
          : typeof deal.entryPrice === 'number'
            ? deal.entryPrice
            : typeof raw.price === 'number'
              ? raw.price
              : null;

      if (!entryPrice || entryPrice <= 0) return true;

      if (unit === 'percent') {
        if (typeof stopLoss !== 'number' || typeof takeProfit !== 'number') return true;
        const slPercent = Math.abs(((entryPrice - stopLoss) / entryPrice) * 100);
        const tpPercent = Math.abs(((takeProfit - entryPrice) / entryPrice) * 100);
        return !nearlyEqual(slPercent, expectedSl) || !nearlyEqual(tpPercent, expectedTp);
      }

      const slMoney = parseMoney(raw, ['stopLossMoney', 'stopLossAmount', 'slAmount']);
      const tpMoney = parseMoney(raw, ['takeProfitMoney', 'takeProfitAmount', 'tpAmount']);
      if (slMoney === null || tpMoney === null) return true;
      return !nearlyEqual(slMoney, expectedSl) || !nearlyEqual(tpMoney, expectedTp);
    });

    return {
      violated: missingOrInvalidDeals.length > 0,
      message:
        missingOrInvalidDeals.length > 0
          ? `Detected ${missingOrInvalidDeals.length} trades without compliant SL/TP. System will auto-apply plan SL/TP.`
          : undefined,
      severity: 'warning',
      actionType: toActionType(rule.action),
      payload: {
        missingDeals: missingOrInvalidDeals.map((deal) => ({
          providerDealId: deal.providerDealId,
          entryPrice: deal.entryPrice,
          raw: deal.raw
        })),
        slTpUnit: unit,
        stopLossValue: expectedSl,
        takeProfitValue: expectedTp
      }
    };
  }
};

export function evaluateRules(context: RuleExecutionContext) {
  const plan = context.plan.rules as PlanRulesPayload;
  return plan.rules
    .filter((rule) => rule.enabled)
    .map((rule) => ({ rule, result: ruleRegistry[rule.key]?.(rule, context) ?? { violated: false } }))
    .filter((entry) => entry.result.violated);
}
