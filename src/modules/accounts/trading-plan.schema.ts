import { z } from 'zod';

const baseRule = z.object({
  key: z.string(),
  enabled: z.boolean().default(true),
  action: z.enum(['pause_account', 'request_close_positions', 'notify'])
});

const allowedHoursRule = baseRule.extend({
  key: z.literal('allowed_hours'),
  value: z.object({ start: z.number().min(0).max(23), end: z.number().min(0).max(23) })
});

export const tradingPlanSchema = z.object({
  planNarrative: z.string().min(20).max(5000),
  timezone: z
    .string()
    .min(1)
    .refine((value) => {
      try {
        Intl.DateTimeFormat(undefined, { timeZone: value });
        return value !== 'UTC';
      } catch {
        return false;
      }
    }, 'timezone must be a valid broker IANA timezone and cannot be UTC (e.g. America/New_York)'),
  riskProfile: z.enum(['conservative', 'moderate', 'aggressive']).default('moderate'),
  resetPolicy: z
    .object({
      dailyReset: z.boolean().default(true),
      lockTradingUntilNextDayOnBreach: z.boolean().default(true)
    })
    .default({ dailyReset: true, lockTradingUntilNextDayOnBreach: true }),
  executionControls: z
    .object({
      enforceStopLoss: z.boolean().default(true),
      enforceTakeProfit: z.boolean().default(true),
      slTpUnit: z.enum(['percent', 'money']).default('percent'),
      stopLossValue: z.number().positive(),
      takeProfitValue: z.number().positive(),
      minRiskRewardRatio: z.number().positive().max(100).default(1)
    })
    .default({ enforceStopLoss: true, enforceTakeProfit: true, slTpUnit: 'percent', stopLossValue: 1, takeProfitValue: 2, minRiskRewardRatio: 1 }),
  rules: z
    .array(
      z.discriminatedUnion('key', [
        baseRule.extend({ key: z.literal('max_daily_loss'), value: z.number().negative() }),
        baseRule.extend({ key: z.literal('max_daily_profit_target'), value: z.number().positive(), action: z.literal('pause_account') }),
        baseRule.extend({ key: z.literal('max_total_loss'), value: z.number().negative() }),
        baseRule.extend({ key: z.literal('max_drawdown'), value: z.number().positive() }),
        baseRule.extend({ key: z.literal('max_trades_per_day'), value: z.number().int().positive(), action: z.literal('pause_account') }),
        allowedHoursRule,
        baseRule.extend({ key: z.literal('close_all_at_midnight'), value: z.boolean() }),
        baseRule.extend({ key: z.literal('require_stop_loss_take_profit'), value: z.boolean().default(true), action: z.literal('notify') })
      ])
    )
    .min(1)
    .superRefine((rules, ctx) => {
      const allowed = rules.find((rule) => rule.key === 'allowed_hours') as z.infer<typeof allowedHoursRule> | undefined;
      if (allowed && allowed.value.start === allowed.value.end) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'allowed_hours.start and end cannot be equal' });
      }
    }),
  }).superRefine((plan, ctx) => {
    const rr = plan.executionControls.takeProfitValue / plan.executionControls.stopLossValue;
    if (rr < plan.executionControls.minRiskRewardRatio) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'takeProfitValue/stopLossValue must be >= minRiskRewardRatio',
        path: ['executionControls', 'takeProfitValue']
      });
    }
});

export type TradingPlanInput = z.infer<typeof tradingPlanSchema>;
