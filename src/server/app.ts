import Fastify from 'fastify';
import { env } from '../config/env.js';
import { logger } from '../util/logger.js';
import { createCrmClient } from '../crm/index.js';
import type { CrmClient } from '../crm/types.js';
import { normalizeWebhook, type HighLevelInboundWebhook } from './webhook.js';

export interface AppDeps {
  crm: CrmClient;
}

/**
 * Build the Fastify app. Dependencies are injected so tests can pass a seeded
 * MockCrmClient. Phase 0 wires the webhook to normalization + an idempotency
 * stub; the orchestrator (Phase 2) replaces the TODO with a real turn.
 */
export function buildApp(deps: AppDeps = { crm: createCrmClient() }) {
  const app = Fastify({ loggerInstance: logger });

  app.get('/health', async () => ({
    status: 'ok',
    crm: deps.crm.kind,
    provider: env.LLM_PROVIDER,
    uptime: process.uptime(),
  }));

  app.post('/webhook', async (request, reply) => {
    const raw = request.body as HighLevelInboundWebhook;
    const result = normalizeWebhook(raw ?? {});

    if ('skip' in result) {
      request.log.debug({ reason: result.skip }, 'webhook skipped');
      // Always 200 so HighLevel does not retry a payload we intentionally ignore.
      return reply.code(200).send({ ignored: result.skip });
    }

    // TODO(Phase 2): idempotency dedupe + enqueue on the per-conversation queue,
    // then run the orchestrator turn. For now, acknowledge receipt.
    request.log.info(
      { conversationId: result.message.conversationId, messageId: result.message.messageId },
      'inbound message received',
    );
    return reply.code(202).send({ accepted: true, messageId: result.message.messageId });
  });

  return app;
}
