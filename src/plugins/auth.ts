import fp from 'fastify-plugin';
import { FastifyInstance } from 'fastify';
import { env } from '../config/env';

export default fp(async (app: FastifyInstance) => {
  app.register(import('@fastify/jwt'), {
    secret: env.JWT_SECRET
  });

  app.decorate('authenticate', async (request: any, reply: any) => {
    try {
      const payload = (await request.jwtVerify()) as { userId: string; role: string; email: string };
      request.authUser = payload;
    } catch {
      return reply.code(401).send({ message: 'Unauthorized' });
    }
  });
});

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: any, reply: any) => Promise<void>;
  }
}
