import Fastify, { FastifyError } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import authPlugin from './plugins/auth';
import swaggerPlugin from './plugins/swagger';
import observabilityPlugin from './plugins/observability';
import { authRoutes } from './modules/auth/auth.routes';
import { billingRoutes } from './modules/billing/billing.routes';
import { webhookRoutes } from './modules/webhooks/webhooks.routes';
import { accountRoutes } from './modules/accounts/accounts.routes';
import { dashboardRoutes } from './modules/dashboard/dashboard.routes';
import { logger } from './lib/logger';

export async function buildApp() {
  const app = Fastify({ logger, bodyLimit: 2_000_000 });

  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body: string, done) => {
    (req as any).rawBody = body;
    try {
      done(null, body ? JSON.parse(body) : {});
    } catch (error) {
      done(error as Error, undefined as any);
    }
  });

  await app.register(cors, { origin: true });
  await app.register(helmet);
  await app.register(rateLimit, { max: 200, timeWindow: '1 minute' });
  await app.register(authPlugin);
  await app.register(swaggerPlugin);
  await app.register(observabilityPlugin);

  await app.register(authRoutes);
  await app.register(billingRoutes);
  await app.register(webhookRoutes);
  await app.register(accountRoutes);
  await app.register(dashboardRoutes);

  app.setErrorHandler((error: FastifyError | ZodError, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({ message: 'Validation error', issues: error.issues });
    }
    if ((error as any).code === 'P2025') {
      return reply.status(404).send({ message: 'Resource not found' });
    }
    return reply.status((error as FastifyError).statusCode ?? 500).send({ message: error.message || 'Internal server error' });
  });

  return app;
}
