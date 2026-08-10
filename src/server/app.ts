import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify from 'fastify';
import type { FastifyRequest } from 'fastify';
import { env } from '../config/env.js';
import { logger } from '../util/logger.js';
import { createCrmClient } from '../crm/index.js';
import type { CrmClient } from '../crm/types.js';
import {
  ConversationDebouncer,
  createOrchestratorStack,
  type OrchestratorStack,
} from '../orchestrator/index.js';
import { createKnowledgeTool } from '../rag/index.js';
import { createSkills } from '../skills/index.js';
import { registerOAuthRoutes } from './oauth.js';
import { verifyHighLevelSignature } from './hl-signature.js';
import { normalizeWebhook, type HighLevelInboundWebhook } from './webhook.js';

export interface AppDeps {
  crm: CrmClient;
  stack: OrchestratorStack;
  /** Shared secret required on /webhook. Defaults to env.HL_WEBHOOK_SECRET. */
  webhookSecret?: string;
  /** Debounce window (ms) for coalescing a burst into one turn. 0 = immediate.
   *  Defaults to env.MESSAGE_DEBOUNCE_MS. Tests pass 0 for determinism. */
  debounceMs?: number;
}

/** The secret from the request, via `x-webhook-secret` or `Authorization: Bearer`. */
function providedSecret(request: FastifyRequest): string | undefined {
  const header = request.headers['x-webhook-secret'];
  if (typeof header === 'string' && header.length > 0) return header;
  const auth = request.headers.authorization;
  if (typeof auth === 'string') return auth.replace(/^Bearer\s+/i, '');
  return undefined;
}

/**
 * Constant-time secret check. When no secret is configured the endpoint is open
 * (local dev); once set, a missing or mismatched secret is rejected. Comparing
 * in constant time avoids leaking the secret length/prefix via timing.
 */
function secretOk(provided: string | undefined, expected: string | undefined): boolean {
  if (!expected) return true;
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function defaultDeps(): AppDeps {
  const crm = createCrmClient();
  // RAG retrieval + skills are all tools the agent may call — one flat registry.
  const tools = [createKnowledgeTool(), ...createSkills()];
  const stack = createOrchestratorStack(crm, tools, { businessName: 'Demo Realty' });
  return { crm, stack };
}

/**
 * Build the Fastify app. Deps are injected so tests can supply a seeded mock
 * CRM + orchestrator stack and await the queue to observe the reply.
 */
export function buildApp(deps: AppDeps = defaultDeps()) {
  const app = Fastify({ loggerInstance: logger });
  const { orchestrator, queue, idempotency } = deps.stack;
  const webhookSecret = deps.webhookSecret ?? env.HL_WEBHOOK_SECRET;

  // Coalesce a rapid burst per conversation into one turn, then serialize turns
  // on the queue. Every idempotency key in the batch is closed together.
  const debouncer = new ConversationDebouncer(
    deps.debounceMs ?? env.MESSAGE_DEBOUNCE_MS,
    ({ message, keys }) => {
      void queue
        .enqueue(message.conversationId, () => orchestrator.runTurn(message))
        .then((trace) => {
          // Release keys on failure (so a redelivery reprocesses), else close them.
          for (const key of keys) {
            if (trace.error) void idempotency.delete(key);
            else void idempotency.markDone(key);
          }
          if (trace.error) {
            logger.warn({ conversationId: message.conversationId }, 'turn errored; keys released');
          }
        })
        .catch((err) => {
          for (const key of keys) void idempotency.delete(key);
          logger.error({ err, conversationId: message.conversationId }, 'turn processing failed');
        });
    },
  );

  // Keep the raw JSON body alongside the parsed one — HighLevel signs the exact
  // bytes, so we must verify against the raw string, not a re-serialized object.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req, body, done) => {
      const raw = typeof body === 'string' ? body : body.toString('utf8');
      (_req as unknown as { rawBody?: string }).rawBody = raw;
      try {
        done(null, raw ? JSON.parse(raw) : {});
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  // Cast around Fastify's custom-logger generic (the injected pino instance
  // makes the concrete type diverge from the default FastifyInstance).
  registerOAuthRoutes(app as unknown as Parameters<typeof registerOAuthRoutes>[0]);

  app.get('/health', async () => ({
    status: 'ok',
    crm: deps.crm.kind,
    provider: env.LLM_PROVIDER,
    uptime: process.uptime(),
  }));

  // Public demo page (Demo Realty) — embeds the HighLevel Live Chat widget,
  // so `/` is a clickable end-to-end demo. Read once at boot; absent = skip.
  let demoHtml = '';
  try {
    demoHtml = readFileSync(join(process.cwd(), 'public', 'index.html'), 'utf8');
  } catch {
    logger.debug('no public/index.html — demo page route disabled');
  }
  if (demoHtml) {
    app.get('/', async (_request, reply) => reply.type('text/html').send(demoHtml));
  }

  app.post('/webhook', async (request, reply) => {
    // Authenticity: accept EITHER our shared secret (our own workflow/test POSTs)
    // OR a valid HighLevel signature (native InboundMessage webhooks don't send
    // our secret — they sign the payload with HighLevel's key instead).
    const rawBody = (request as unknown as { rawBody?: string }).rawBody ?? '';
    const authed =
      secretOk(providedSecret(request), webhookSecret) ||
      verifyHighLevelSignature(rawBody, request.headers);
    if (!authed) {
      request.log.warn('webhook rejected: no valid secret or HighLevel signature');
      return reply.code(401).send({ error: 'unauthorized' });
    }

    const result = normalizeWebhook((request.body ?? {}) as HighLevelInboundWebhook);

    if ('skip' in result) {
      request.log.debug({ reason: result.skip }, 'webhook skipped');
      // 200 so HighLevel does not retry a payload we intentionally ignore.
      return reply.code(200).send({ ignored: result.skip });
    }

    // Idempotency: drop duplicate deliveries of the same message.
    if (!(await idempotency.markIfNew(result.idempotencyKey, result.message.conversationId))) {
      request.log.info({ messageId: result.idempotencyKey }, 'duplicate webhook dropped');
      return reply.code(200).send({ duplicate: true });
    }

    // Ack fast; the debouncer coalesces a rapid burst into one turn, then the
    // per-conversation queue serializes turns so a slow one never blocks a webhook.
    debouncer.add(result.message, result.idempotencyKey);

    request.log.info(
      { conversationId: result.message.conversationId, messageId: result.message.messageId },
      'inbound message accepted',
    );
    return reply.code(202).send({ accepted: true, messageId: result.message.messageId });
  });

  return app;
}
