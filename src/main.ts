import { env } from './config/env.js';
import { logger } from './util/logger.js';
import { buildApp } from './server/app.js';
import { shutdownTracing } from './trace/emit.js';

async function main(): Promise<void> {
  const app = buildApp();
  try {
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
    logger.info(
      { port: env.PORT, provider: env.LLM_PROVIDER, crm: env.CRM_MODE },
      'harness listening',
    );
  } catch (err) {
    logger.error(err, 'failed to start');
    process.exit(1);
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      logger.info({ signal }, 'shutting down');
      void app
        .close()
        .then(() => shutdownTracing())
        .then(() => process.exit(0));
    });
  }
}

void main();
