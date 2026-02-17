export type RuleLike = { key: string; value?: any; enabled?: boolean };

export type ComplianceInput = {
  rules: RuleLike[];
  dailyPnl: number;
  tradesCount: number;
  now: Date;
  riskPausedUntil: Date | null;
};

export function buildPreventiveAlerts(input: ComplianceInput) {
  const alerts: Array<{ ruleKey: string; level: 'info' | 'warning' | 'critical'; message: string; remaining?: number; unit?: string }> = [];

  const byKey = new Map(input.rules.filter((r) => r.enabled !== false).map((rule) => [rule.key, rule]));

  const maxDailyLoss = byKey.get('max_daily_loss');
  if (maxDailyLoss && typeof maxDailyLoss.value === 'number') {
    const maxLossAbs = Math.abs(maxDailyLoss.value);
    const usedLoss = Math.max(0, Math.abs(Math.min(0, input.dailyPnl)));
    const remaining = Math.max(0, maxLossAbs - usedLoss);
    const ratio = maxLossAbs > 0 ? usedLoss / maxLossAbs : 0;
    if (remaining === 0) {
      alerts.push({ ruleKey: 'max_daily_loss', level: 'critical', message: 'Límite de pérdida diaria alcanzado.', remaining: 0, unit: 'currency' });
    } else if (ratio >= 0.8) {
      alerts.push({ ruleKey: 'max_daily_loss', level: 'warning', message: 'Estás cerca del límite de pérdida diaria.', remaining, unit: 'currency' });
    }
  }

  const maxTrades = byKey.get('max_trades_per_day');
  if (maxTrades && typeof maxTrades.value === 'number') {
    const remaining = Math.max(0, maxTrades.value - input.tradesCount);
    if (remaining === 0) {
      alerts.push({ ruleKey: 'max_trades_per_day', level: 'critical', message: 'Límite diario de operaciones alcanzado.', remaining: 0, unit: 'trades' });
    } else if (remaining <= 2) {
      alerts.push({ ruleKey: 'max_trades_per_day', level: 'warning', message: 'Te quedan pocas operaciones hoy.', remaining, unit: 'trades' });
    }
  }

  const target = byKey.get('max_daily_profit_target');
  if (target && typeof target.value === 'number') {
    const remaining = Math.max(0, target.value - input.dailyPnl);
    if (remaining === 0) {
      alerts.push({ ruleKey: 'max_daily_profit_target', level: 'info', message: 'Objetivo diario cumplido.', remaining: 0, unit: 'currency' });
    } else if (remaining <= target.value * 0.2) {
      alerts.push({ ruleKey: 'max_daily_profit_target', level: 'info', message: 'Estás cerca de cumplir tu objetivo diario.', remaining, unit: 'currency' });
    }
  }

  const lock =
    input.riskPausedUntil && input.riskPausedUntil > input.now
      ? {
          active: true,
          until: input.riskPausedUntil,
          secondsRemaining: Math.max(0, Math.floor((input.riskPausedUntil.getTime() - input.now.getTime()) / 1000))
        }
      : { active: false, until: null, secondsRemaining: 0 };

  return { alerts, lock };
}
