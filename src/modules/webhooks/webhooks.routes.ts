import { FastifyInstance } from 'fastify';
import { prisma } from '../../lib/prisma';
import { stripe } from '../../services/stripe.service';
import { env } from '../../config/env';
import { JobType, SubscriptionStatus } from '@prisma/client';
import { isWebhookProcessed } from './stripe-webhook.service';
import { enqueueJob } from '../../services/job.service';

function toSubscriptionStatus(status: string): SubscriptionStatus {
  const map: Record<string, SubscriptionStatus> = {
    incomplete: 'INCOMPLETE',
    incomplete_expired: 'INCOMPLETE_EXPIRED',
    trialing: 'TRIALING',
    active: 'ACTIVE',
    past_due: 'PAST_DUE',
    canceled: 'CANCELED',
    unpaid: 'UNPAID',
    paused: 'PAUSED'
  };
  return map[status] ?? 'INCOMPLETE';
}

export async function webhookRoutes(app: FastifyInstance) {
  app.post('/webhooks/stripe', async (request, reply) => {
    const signature = request.headers['stripe-signature'];
    if (!signature || Array.isArray(signature)) return reply.code(400).send({ message: 'Missing stripe-signature' });

    let event;
    try {
      event = stripe.webhooks.constructEvent((request as any).rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
    } catch (error: any) {
      return reply.code(400).send({ message: `Invalid signature: ${error.message}` });
    }

    const processed = await isWebhookProcessed(prisma as any, 'stripe', event.id);
    if (processed) return { idempotent: true };

    const webhook = await prisma.webhookEvent.upsert({
      where: { provider_providerEventId: { provider: 'stripe', providerEventId: event.id } },
      create: {
        provider: 'stripe',
        providerEventId: event.id,
        type: event.type,
        payload: event as any,
        signature
      },
      update: { type: event.type, payload: event as any, signature }
    });

    try {
      if (event.type.startsWith('customer.subscription')) {
        const subscription = event.data.object as any;
        await prisma.subscription.updateMany({
          where: {
            OR: [{ stripeSubscriptionId: subscription.id }, { stripeCustomerId: subscription.customer }]
          },
          data: {
            stripeSubscriptionId: subscription.id,
            status: toSubscriptionStatus(subscription.status),
            currentPeriodStart: new Date(subscription.current_period_start * 1000),
            currentPeriodEnd: new Date(subscription.current_period_end * 1000),
            cancelAt: subscription.cancel_at ? new Date(subscription.cancel_at * 1000) : null,
            canceledAt: subscription.canceled_at ? new Date(subscription.canceled_at * 1000) : null
          }
        });
      }

      if (event.type === 'checkout.session.completed') {
        const session = event.data.object as any;
        let normalizedStatus: SubscriptionStatus = 'INCOMPLETE';
        let periodStart: Date | null = null;
        let periodEnd: Date | null = null;
        let stripeCustomerId = session.customer ? String(session.customer) : null;
        const userIdFromSession = session.metadata?.userId ? String(session.metadata.userId) : null;

        if (session.subscription) {
          const stripeSubscription = await stripe.subscriptions.retrieve(String(session.subscription));
          normalizedStatus = toSubscriptionStatus(stripeSubscription.status);
          periodStart = stripeSubscription.current_period_start ? new Date(stripeSubscription.current_period_start * 1000) : null;
          periodEnd = stripeSubscription.current_period_end ? new Date(stripeSubscription.current_period_end * 1000) : null;
          stripeCustomerId = stripeCustomerId ?? (stripeSubscription.customer ? String(stripeSubscription.customer) : null);
        }

        if (stripeCustomerId) {
          const existing = await prisma.subscription.findFirst({
            where: {
              OR: [
                { stripeCustomerId },
                ...(session.subscription ? [{ stripeSubscriptionId: String(session.subscription) }] : []),
                ...(userIdFromSession ? [{ userId: userIdFromSession }] : [])
              ]
            },
            orderBy: { updatedAt: 'desc' }
          });

          if (existing) {
            await prisma.subscription.update({
              where: { id: existing.id },
              data: {
                stripeCustomerId,
                stripeSubscriptionId: session.subscription ? String(session.subscription) : existing.stripeSubscriptionId,
                status: normalizedStatus,
                currentPeriodStart: periodStart,
                currentPeriodEnd: periodEnd
              }
            });
          } else if (userIdFromSession) {
            await prisma.subscription.create({
              data: {
                userId: userIdFromSession,
                stripeCustomerId,
                stripeSubscriptionId: session.subscription ? String(session.subscription) : null,
                status: normalizedStatus,
                currentPeriodStart: periodStart,
                currentPeriodEnd: periodEnd
              }
            });
          }
        }
      }

      if (event.type.startsWith('invoice.')) {
        const invoice = event.data.object as any;
        await prisma.auditLog.create({
          data: {
            action: event.type,
            entityType: 'StripeInvoice',
            entityId: String(invoice.id),
            metadata: {
              stripeSubscriptionId: invoice.subscription,
              stripeInvoiceId: invoice.id,
              stripePaymentIntentId: invoice.payment_intent,
              stripeCustomerId: invoice.customer,
              amountPaid: invoice.amount_paid,
              amountDue: invoice.amount_due
            }
          }
        });
      }


      await enqueueJob(JobType.SUBSCRIPTION_EXPIRY, undefined, { reason: `stripe_event:${event.type}` });
      await prisma.webhookEvent.update({ where: { id: webhook.id }, data: { processedAt: new Date(), processingError: null } });
      return { received: true };
    } catch (error: any) {
      await prisma.webhookEvent.update({ where: { id: webhook.id }, data: { processingError: error.message } });
      throw error;
    }
  });
}
