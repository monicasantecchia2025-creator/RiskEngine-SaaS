import { buildApp } from './app';
import { env } from './config/env';

(async () => {
  const app = await buildApp();
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
})();
