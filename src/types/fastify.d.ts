import 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    authUser?: {
      userId: string;
      role: string;
      email: string;
    };
  }
}
