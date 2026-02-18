import { Platform } from '@prisma/client';
import { env } from '../config/env';

type MetaApiAccount = {
  _id: string;
  state?: string;
  connectionStatus?: string;
  platform?: 'mt4' | 'mt5';
  login?: string;
  name?: string;
};

type MetaApiDeal = {
  id: string;
  symbol: string;
  type: string;
  volume: number;
  price: number;
  profit?: number;
  doneTime?: string;
  stopLoss?: number | null;
  takeProfit?: number | null;
};

type ProvisionInput = {
  accountName: string;
  platform: Platform;
  login: string;
  password: string;
  server: string;
  brokerName?: string;
};

class MetaApiService {
  private headers() {
    return {
      'auth-token': env.METAAPI_TOKEN,
      'content-type': 'application/json'
    };
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${env.METAAPI_BASE_URL}${path}`, {
      ...init,
      headers: { ...this.headers(), ...(init?.headers ?? {}) }
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`MetaApi ${res.status}: ${body}`);
    }

    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  private isConnectPathMissing(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes('MetaApi 404') && message.includes('/connect');
  }

  async createAndConnectAccount(input: ProvisionInput): Promise<MetaApiAccount> {
    const payload = {
      name: input.accountName,
      type: 'cloud-g1',
      login: input.login,
      password: input.password,
      server: input.server,
      platform: input.platform === Platform.MT4 ? 'mt4' : 'mt5',
      magic: 1000,
      quoteStreamingIntervalInSeconds: 2.5,
      region: 'new-york',
      tags: ['risk-engine-saas', input.brokerName ?? 'broker']
    };

    const created = await this.request<{ id?: string; _id?: string }>(`/users/current/accounts`, {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    const accountId = created.id ?? created._id;
    if (!accountId) throw new Error('MetaApi account creation returned no id');

    await this.request(`/users/current/accounts/${accountId}/deploy`, { method: 'POST' });

    try {
      await this.request(`/users/current/accounts/${accountId}/connect`, { method: 'POST' });
    } catch (error) {
      if (!this.isConnectPathMissing(error)) {
        throw error;
      }
      // Some MetaApi provisioning environments do not expose explicit /connect path.
      // In that case deploy is enough and sync worker treats DEPLOYED as connected.
    }

    return this.getAccount(accountId);
  }

  async getAccount(metaapiAccountId: string) {
    return this.request<MetaApiAccount>(`/users/current/accounts/${metaapiAccountId}`);
  }

  async validateAccount(metaapiAccountId: string, platform: Platform) {
    const account = await this.getAccount(metaapiAccountId);
    if (!account?._id) throw new Error('MetaApi account not found');

    const expected = platform === Platform.MT4 ? 'mt4' : 'mt5';
    if (account.platform && account.platform !== expected) {
      throw new Error(`MetaApi account platform mismatch. Expected ${expected}, got ${account.platform}`);
    }

    return account;
  }

  async syncAccount(metaapiAccountId: string) {
    const account = await this.getAccount(metaapiAccountId);
    const connected = account.connectionStatus === 'CONNECTED' || account.state === 'DEPLOYED';

    const [metrics, deals] = await Promise.all([
      this.request<any>(`/users/current/accounts/${metaapiAccountId}/metrics`).catch(() => null),
      this.request<MetaApiDeal[]>(`/users/current/accounts/${metaapiAccountId}/deals?limit=200`).catch(() => [])
    ]);

    return {
      connected,
      equity: Number(metrics?.equity ?? 0),
      balance: Number(metrics?.balance ?? 0),
      pnl: Number(metrics?.profit ?? 0),
      deals
    };
  }

  async requestClosePositions(metaapiAccountId: string) {
    await this.request(`/users/current/accounts/${metaapiAccountId}/close-positions`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Risk rule violation' })
    });
  }

  async pauseAccount(metaapiAccountId: string) {
    await this.request(`/users/current/accounts/${metaapiAccountId}`, {
      method: 'PUT',
      body: JSON.stringify({ manualTrades: false, quoteStreamingIntervalInSeconds: 0 })
    });
  }

  async resumeAccount(metaapiAccountId: string) {
    await this.request(`/users/current/accounts/${metaapiAccountId}`, {
      method: 'PUT',
      body: JSON.stringify({ manualTrades: true, quoteStreamingIntervalInSeconds: 2.5 })
    });
  }

  async applyStopLossTakeProfit(params: {
    metaapiAccountId: string;
    positionId: string;
    entryPrice: number;
    slTpUnit: 'percent' | 'money';
    stopLossValue: number;
    takeProfitValue: number;
  }) {
    const payload: Record<string, unknown> = {
      comment: 'Auto-applied by Risk Engine plan enforcement'
    };

    if (params.slTpUnit === 'percent') {
      payload.stopLoss = Number((params.entryPrice * (1 - params.stopLossValue / 100)).toFixed(6));
      payload.takeProfit = Number((params.entryPrice * (1 + params.takeProfitValue / 100)).toFixed(6));
    } else {
      payload.stopLossMoney = params.stopLossValue;
      payload.takeProfitMoney = params.takeProfitValue;
    }

    await this.request(`/users/current/accounts/${params.metaapiAccountId}/positions/${params.positionId}/modify`, {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  }
}

export const metaApiService = new MetaApiService();
