import { describe, expect, it, vi } from 'vitest';
import { isWebhookProcessed } from '../src/modules/webhooks/stripe-webhook.service';

describe('stripe webhook idempotency', () => {
  it('returns true if already processed', async () => {
    const prisma = {
      webhookEvent: {
        findUnique: vi.fn().mockResolvedValue({ processedAt: new Date() })
      }
    } as any;

    const processed = await isWebhookProcessed(prisma, 'stripe', 'evt_123');
    expect(processed).toBe(true);
  });
});
