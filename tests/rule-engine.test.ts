import { describe, expect, it } from 'vitest';
import { evaluateRules } from '../src/modules/risk/rule-engine';

describe('rule engine', () => {
  it('detects max daily loss violation', () => {
    const results = evaluateRules({
      account: { id: 'a1' } as any,
      plan: { rules: { rules: [{ key: 'max_daily_loss', value: -200, action: 'pause_account', enabled: true }] } } as any,
      deals: [],
      metrics: { dailyPnl: -250, drawdown: 0, tradesCount: 0 } as any,
      now: new Date()
    });

    expect(results).toHaveLength(1);
    expect(results[0].result.actionType).toBe('PAUSE_ACCOUNT');
    expect(results[0].result.lockUntilNextDay).toBe(true);
  });

  it('locks account when daily target is reached', () => {
    const results = evaluateRules({
      account: { id: 'a1' } as any,
      plan: { rules: { rules: [{ key: 'max_daily_profit_target', value: 500, action: 'pause_account', enabled: true }] } } as any,
      deals: [],
      metrics: { dailyPnl: 520, drawdown: 0, tradesCount: 2 } as any,
      now: new Date()
    });

    expect(results).toHaveLength(1);
    expect(results[0].result.lockUntilNextDay).toBe(true);
  });

  it('locks account until next day when daily trade limit reached', () => {
    const results = evaluateRules({
      account: { id: 'a1' } as any,
      plan: { rules: { rules: [{ key: 'max_trades_per_day', value: 3, action: 'pause_account', enabled: true }] } } as any,
      deals: [],
      metrics: { dailyPnl: 100, drawdown: 0, tradesCount: 3 } as any,
      now: new Date()
    });

    expect(results).toHaveLength(1);
    expect(results[0].result.lockUntilNextDay).toBe(true);
  });

  it('detects missing stop loss/take profit', () => {
    const results = evaluateRules({
      account: { id: 'a1' } as any,
      plan: {
        rules: {
          executionControls: { slTpUnit: 'percent', stopLossValue: 1, takeProfitValue: 2 },
          rules: [{ key: 'require_stop_loss_take_profit', value: true, action: 'notify', enabled: true }]
        }
      } as any,
      deals: [{ providerDealId: 'd1', raw: { stopLoss: null, takeProfit: 1.2 } }] as any,
      metrics: null,
      now: new Date()
    });

    expect(results).toHaveLength(1);
    expect(results[0].result.message).toContain('auto-apply plan SL/TP');
    expect(results[0].result.actionType).toBe('NOTIFY');
  });

  it('detects immutable SL/TP mismatch in percent mode', () => {
    const results = evaluateRules({
      account: { id: 'a1' } as any,
      plan: {
        rules: {
          executionControls: { slTpUnit: 'percent', stopLossValue: 1, takeProfitValue: 2 },
          rules: [{ key: 'require_stop_loss_take_profit', value: true, action: 'notify', enabled: true }]
        }
      } as any,
      deals: [{ providerDealId: 'd2', entryPrice: 100, raw: { stopLoss: 97, takeProfit: 102 } }] as any,
      metrics: null,
      now: new Date()
    });

    expect(results).toHaveLength(1);
  });

  it('passes when immutable SL/TP matches money mode', () => {
    const results = evaluateRules({
      account: { id: 'a1' } as any,
      plan: {
        rules: {
          executionControls: { slTpUnit: 'money', stopLossValue: 50, takeProfitValue: 100 },
          rules: [{ key: 'require_stop_loss_take_profit', value: true, action: 'notify', enabled: true }]
        }
      } as any,
      deals: [
        { providerDealId: 'd3', entryPrice: 100, raw: { stopLoss: 99, takeProfit: 101, stopLossMoney: 50, takeProfitMoney: 100 } }
      ] as any,
      metrics: null,
      now: new Date()
    });

    expect(results).toHaveLength(0);
  });

  it('evaluates allowed_hours using broker timezone (not UTC)', () => {
    const results = evaluateRules({
      account: { id: 'a1' } as any,
      plan: {
        timezone: 'America/New_York',
        rules: {
          rules: [{ key: 'allowed_hours', value: { start: 7, end: 20 }, action: 'notify', enabled: true }]
        }
      } as any,
      deals: [],
      metrics: null,
      now: new Date('2026-01-01T03:00:00Z')
    });

    expect(results).toHaveLength(1);
    expect(results[0].result.message).toContain('America/New_York');
  });

  it('triggers close_all_at_midnight using broker timezone', () => {
    const results = evaluateRules({
      account: { id: 'a1' } as any,
      plan: {
        timezone: 'America/New_York',
        rules: {
          rules: [{ key: 'close_all_at_midnight', value: true, action: 'request_close_positions', enabled: true }]
        }
      } as any,
      deals: [],
      metrics: null,
      now: new Date('2026-01-01T05:03:00Z')
    });

    expect(results).toHaveLength(1);
    expect(results[0].result.message).toContain('America/New_York');
  });
});
