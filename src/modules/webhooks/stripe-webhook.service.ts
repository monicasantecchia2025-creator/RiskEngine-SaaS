import { PrismaClient } from '@prisma/client';

export async function isWebhookProcessed(prisma: PrismaClient, provider: string, providerEventId: string) {
  const existing = await prisma.webhookEvent.findUnique({
    where: { provider_providerEventId: { provider, providerEventId } }
  });
  return Boolean(existing?.processedAt);
}
