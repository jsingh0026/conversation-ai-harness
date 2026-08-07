import { env } from '../../config/env.js';
import { HighLevelClient } from './client.js';
import { HlHttp } from './http.js';
import { TokenManager } from './token-manager.js';

export { HighLevelClient } from './client.js';
export { TokenManager } from './token-manager.js';
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
  tokenManager: TokenManager;
  client: HighLevelClient;
}
let ctx: HlContext | undefined;

function requireEnv(): { clientId: string; clientSecret: string; redirectUri: string; locationId: string } {
  const missing = (['HL_CLIENT_ID', 'HL_CLIENT_SECRET', 'HL_REDIRECT_URI', 'HL_LOCATION_ID'] as const).filter(
    (k) => !env[k],
  );
  if (missing.length) {
    throw new Error(`HighLevel not configured — missing env: ${missing.join(', ')}`);
  }
  return {
    clientId: env.HL_CLIENT_ID!,
    clientSecret: env.HL_CLIENT_SECRET!,
    redirectUri: env.HL_REDIRECT_URI!,
    locationId: env.HL_LOCATION_ID!,
  };
}

/** Lazily build the shared TokenManager + client (so OAuth routes and the CRM share state). */
export function getHighLevelContext(): HlContext {
  if (ctx) return ctx;
  const cfg = requireEnv();
  const tokenManager = new TokenManager({
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    redirectUri: cfg.redirectUri,
  });
  const client = new HighLevelClient(new HlHttp(tokenManager), {
    locationId: cfg.locationId,
    fieldMap: { budget: env.HL_FIELD_BUDGET_ID, preferredTime: env.HL_FIELD_PREFERRED_TIME_ID },
    // Appointments need an assignee; fall back to the handover user if set.
    assignedUserId: env.HL_CALENDAR_USER_ID ?? env.HL_HANDOVER_USER_ID,
  });
  ctx = { tokenManager, client };
  return ctx;
}

export function createHighLevelClient(): HighLevelClient {
  return getHighLevelContext().client;
}

/** The Marketplace consent URL the user visits to install/authorize the app. */
export function buildAuthorizeUrl(): string {
  const cfg = requireEnv();
  const url = new URL('https://marketplace.gohighlevel.com/oauth/chooselocation');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', cfg.clientId);
  url.searchParams.set('redirect_uri', cfg.redirectUri);
  url.searchParams.set('scope', SCOPES.join(' '));
  return url.toString();
}
