import { env } from '../../config/env.js';
import { HighLevelClient } from './client.js';
import { HlHttp } from './http.js';
import { StaticTokenProvider, TokenManager } from './token-manager.js';

export { HighLevelClient } from './client.js';
export { TokenManager, StaticTokenProvider } from './token-manager.js';
export { HlHttp, HlApiError } from './http.js';

/** OAuth scopes the app requests — must match the Marketplace app config. */
const SCOPES = [
  'conversations.readonly',
  'conversations.write',
  'conversations/message.readonly',
  'conversations/message.write',
  'contacts.readonly',
  'contacts.write',
  'locations/customFields.readonly',
  'calendars.readonly',
  'calendars/events.readonly',
  'calendars/events.write',
  'users.readonly',
];

interface HlContext {
  client: HighLevelClient;
  http: HlHttp;
  /** Present only in OAuth mode (undefined when a private token is used). */
  tokenManager?: TokenManager;
}
let ctx: HlContext | undefined;

function requireOAuthEnv(): { clientId: string; clientSecret: string; redirectUri: string } {
  const missing = (['HL_CLIENT_ID', 'HL_CLIENT_SECRET', 'HL_REDIRECT_URI'] as const).filter(
    (k) => !env[k],
  );
  if (missing.length) {
    throw new Error(`HighLevel OAuth not configured — missing env: ${missing.join(', ')}`);
  }
  return { clientId: env.HL_CLIENT_ID!, clientSecret: env.HL_CLIENT_SECRET!, redirectUri: env.HL_REDIRECT_URI! };
}

/**
 * Lazily build the shared HighLevel client. Two auth modes:
 *  - `HL_PRIVATE_TOKEN` set → static bearer, no OAuth (simplest for a demo).
 *  - otherwise → OAuth via a shared TokenManager (also used by the OAuth routes).
 */
export function getHighLevelContext(): HlContext {
  if (ctx) return ctx;

  const locationId = env.HL_LOCATION_ID;
  if (!locationId) throw new Error('HighLevel not configured — missing HL_LOCATION_ID');
  const clientConfig = {
    locationId,
    fieldMap: { budget: env.HL_FIELD_BUDGET_ID, preferredTime: env.HL_FIELD_PREFERRED_TIME_ID },
    // Appointments need an assignee; fall back to the handover user if set.
    assignedUserId: env.HL_CALENDAR_USER_ID ?? env.HL_HANDOVER_USER_ID,
    // Lets isBotEnabled rehydrate handover state from the durable contact tag.
    handoverTag: env.HL_HANDOVER_TAG,
  };

  if (env.HL_PRIVATE_TOKEN) {
    const http = new HlHttp(new StaticTokenProvider(env.HL_PRIVATE_TOKEN));
    ctx = { client: new HighLevelClient(http, clientConfig), http };
    return ctx;
  }

  const cfg = requireOAuthEnv();
  const tokenManager = new TokenManager({
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    redirectUri: cfg.redirectUri,
  });
  const http = new HlHttp(tokenManager);
  ctx = { client: new HighLevelClient(http, clientConfig), http, tokenManager };
  return ctx;
}

export function createHighLevelClient(): HighLevelClient {
  return getHighLevelContext().client;
}

/** The Marketplace consent URL the user visits to install/authorize the app. */
export function buildAuthorizeUrl(): string {
  const cfg = requireOAuthEnv();
  const url = new URL('https://marketplace.gohighlevel.com/oauth/chooselocation');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', cfg.clientId);
  url.searchParams.set('redirect_uri', cfg.redirectUri);
  url.searchParams.set('scope', SCOPES.join(' '));
  return url.toString();
}
