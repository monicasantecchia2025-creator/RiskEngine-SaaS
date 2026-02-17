import fp from 'fastify-plugin';

export default fp(async (app) => {
  await app.register(import('@fastify/swagger'), {
    openapi: {
      info: {
        title: 'Risk Engine SaaS API',
        version: '1.0.0'
      },
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT'
          }
        }
      }
    }
  });

  await app.register(import('@fastify/swagger-ui'), {
    routePrefix: '/docs'
  });
});
