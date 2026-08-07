import type { FastifyInstance } from 'fastify';
import { buildAuthorizeUrl, getHighLevelContext } from '../crm/highlevel/index.js';

/**
 * OAuth endpoints for connecting the HighLevel sandbox:
 *   GET /oauth/authorize  → redirect to the Marketplace consent screen
 *   GET /oauth/callback   → exchange the returned code for tokens (persisted)
 * Registered always; they return a clear error if HL isn't configured.
 */
export function registerOAuthRoutes(app: FastifyInstance): void {
  app.get('/oauth/authorize', async (_req, reply) => {
    try {
      return reply.redirect(buildAuthorizeUrl());
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : 'oauth error' });
    }
  });

  app.get('/oauth/callback', async (request, reply) => {
    const code = (request.query as { code?: string }).code;
    if (!code) return reply.code(400).send({ error: 'missing ?code' });
    try {
      const { tokenManager } = getHighLevelContext();
      const token = await tokenManager.exchangeCode(code);
      request.log.info({ locationId: token.locationId }, 'HighLevel authorized');
      return reply.send({ connected: true, locationId: token.locationId });
    } catch (err) {
      request.log.error({ err }, 'oauth callback failed');
      return reply.code(500).send({ error: err instanceof Error ? err.message : 'exchange failed' });
    }
  });
}
