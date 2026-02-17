import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { stripe } from '../../services/stripe.service';
import { env } from '../../config/env';

const bodySchema = z.object({
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
  plan: z.enum(['monthly', 'annual'])
});

export async function billingRoutes(app: FastifyInstance) {
  app.post('/billing/checkout-session', { preHandler: [app.authenticate] }, async (request) => {
    const body = bodySchema.parse(request.body);
    const userId = request.authUser!.userId;
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

    const selectedPriceId = body.plan === 'monthly' ? env.STRIPE_PRICE_ID_MONTHLY : env.STRIPE_PRICE_ID_ANNUAL;

    const subscription = await prisma.subscription.findFirst({ where: { userId }, orderBy: { updatedAt: 'desc' } });
    const stripeCustomerId = subscription?.stripeCustomerId ?? (await stripe.customers.create({ email: user.email, name: user.name })).id;

    if (!subscription) {
      await prisma.subscription.create({
        data: { userId, stripeCustomerId, status: 'INCOMPLETE', stripePriceId: selectedPriceId }
      });
    } else {
      await prisma.subscription.update({
        where: { id: subscription.id },
        data: { stripePriceId: selectedPriceId }
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: stripeCustomerId,
      line_items: [{ price: selectedPriceId, quantity: 1 }],
      success_url: body.successUrl,
      cancel_url: body.cancelUrl,
      metadata: { userId, plan: body.plan }
    });

    return { id: session.id, url: session.url, plan: body.plan };
  });
}
