import Fastify from 'fastify';
import { env } from '../config/env.js';
import { logger } from '../util/logger.js';
import { createCrmClient } from '../crm/index.js';
import type { CrmClient } from '../crm/types.js';
import { createOrchestratorStack, type OrchestratorStack } from '../orchestrator/index.js';
import { createKnowledgeTool } from '../rag/index.js';
import { createSkills } from '../skills/index.js';
import { registerOAuthRoutes } from './oauth.js';
import { normalizeWebhook, type HighLevelInboundWebhook } from './webhook.js';

export interface AppDeps {
  crm: CrmClient;
  stack: OrchestratorStack;
}

function defaultDeps(): AppDeps {
  const crm = createCrmClient();
  // RAG retrieval + skills are all tools the agent may call — one flat registry.
  const tools = [createKnowledgeTool(), ...createSkills()];
  const stack = createOrchestratorStack(crm, tools, { businessName: 'Lumina Realty' });
  return { crm, stack };
}

/**
 * Build the Fastify app. Deps are injected so tests can supply a seeded mock
 * CRM + orchestrator stack and await the queue to observe the reply.
 */
export function buildApp(deps: AppDeps = defaultDeps()) {
  const app = Fastify({ loggerInstance: logger });
  const { orchestrator, queue, idempotency } = deps.stack;

  // Cast around Fastify's custom-logger generic (the injected pino instance
  // makes the concrete type diverge from the default FastifyInstance).
  registerOAuthRoutes(app as unknown as Parameters<typeof registerOAuthRoutes>[0]);

  app.get('/health', async () => ({
    status: 'ok',
    crm: deps.crm.kind,
    provider: env.LLM_PROVIDER,
    uptime: process.uptime(),
  }));

  app.post('/webhook', async (request, reply) => {
    const result = normalizeWebhook((request.body ?? {}) as HighLevelInboundWebhook);

    if ('skip' in result) {
      request.log.debug({ reason: result.skip }, 'webhook skipped');
      // 200 so HighLevel does not retry a payload we intentionally ignore.
      return reply.code(200).send({ ignored: result.skip });
    }

    // Idempotency: drop duplicate deliveries of the same message.
    if (!idempotency.markIfNew(result.idempotencyKey)) {
      request.log.info({ messageId: result.idempotencyKey }, 'duplicate webhook dropped');
      return reply.code(200).send({ duplicate: true });
    }

    // Ack fast; process on the per-conversation queue so rapid back-to-back
    // messages serialize and a slow turn never blocks the webhook.
    const { message } = result;
    void queue
      .enqueue(message.conversationId, () => orchestrator.runTurn(message))
      .then((trace) => {
        // On failure, forget the idempotency key so a HighLevel redelivery can
        // reprocess (a dropped turn = an ignored customer otherwise).
        if (trace.error) {
          idempotency.delete(result.idempotencyKey);
          request.log.warn({ messageId: message.messageId }, 'turn errored; key released for retry');
        }
      })
      .catch((err) => {
        idempotency.delete(result.idempotencyKey);
        request.log.error({ err, messageId: message.messageId }, 'turn processing failed');
      });

    request.log.info(
      { conversationId: message.conversationId, messageId: message.messageId },
      'inbound message accepted',
    );
    return reply.code(202).send({ accepted: true, messageId: message.messageId });
  });

  return app;
}
