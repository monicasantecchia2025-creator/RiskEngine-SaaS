import fp from 'fastify-plugin';
import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

const register = new Registry();
collectDefaultMetrics({ register });

const requestsCounter = new Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register]
});

const requestsDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.05, 0.1, 0.2, 0.5, 1, 2],
  registers: [register]
});

export default fp(async (app) => {
  app.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions.url || request.url;
    requestsCounter.inc({ method: request.method, route, status_code: String(reply.statusCode) });
    requestsDuration.observe({ method: request.method, route, status_code: String(reply.statusCode) }, reply.elapsedTime / 1000);
  });

  app.get('/metrics', async (_req, reply) => {
    reply.type(register.contentType);
    return register.metrics();
  });

  app.get('/health', async () => ({ status: 'ok' }));
});
