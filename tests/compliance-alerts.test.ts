import { describe, expect, it } from 'vitest';
import { buildPreventiveAlerts } from '../src/modules/dashboard/compliance';

describe('compliance alerts', () => {
  it('creates warning when close to daily trade limit', () => {
    const result = buildPreventiveAlerts({
      rules: [{ key: 'max_trades_per_day', value: 10, enabled: true }],
      dailyPnl: 0,
      tradesCount: 9,
      now: new Date('2026-01-01T12:00:00Z'),
      riskPausedUntil: null
    });

    expect(result.alerts.some((a) => a.ruleKey === 'max_trades_per_day')).toBe(true);
    expect(result.lock.active).toBe(false);
  });

  it('returns lock countdown while daily lock is active', () => {
    const now = new Date('2026-01-01T12:00:00Z');
    const until = new Date('2026-01-01T12:01:00Z');
    const result = buildPreventiveAlerts({
      rules: [],
      dailyPnl: 0,
      tradesCount: 0,
      now,
      riskPausedUntil: until
    });

    expect(result.lock.active).toBe(true);
    expect(result.lock.secondsRemaining).toBe(60);
  });
});
