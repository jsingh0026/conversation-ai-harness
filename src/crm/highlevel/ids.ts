/**
 * Print the HighLevel object IDs you need for .env — calendars, staff users, and
 * contact custom fields — so you don't have to dig them out of the UI.
 *
 *   pnpm hl:ids           # after connecting OAuth (visit /oauth/authorize first)
 *
 * Requires CRM_MODE-agnostic HL_* env + a completed OAuth connection (a token at
 * data/hl-token.json).
 */
import { env } from '../../config/env.js';
import { HlHttp } from './http.js';
import { getHighLevelContext } from './index.js';

interface Calendar {
  id: string;
  name?: string;
}
interface User {
  id: string;
  name?: string;
  email?: string;
}
interface CustomField {
  id: string;
  name?: string;
  fieldKey?: string;
  dataType?: string;
}

async function main(): Promise<void> {
  const locationId = env.HL_LOCATION_ID;
  if (!locationId) {
    console.error('HL_LOCATION_ID is not set in .env');
    process.exit(1);
  }

  let http: HlHttp;
  try {
    const ctx = getHighLevelContext();
    // Force a token check up front for a clear error if not connected.
    await ctx.tokenManager.getAccessToken();
    http = new HlHttp(ctx.tokenManager);
  } catch (err) {
    console.error(
      `Not connected to HighLevel: ${err instanceof Error ? err.message : err}\n` +
        'Start the server (`pnpm dev`) and visit http://localhost:3000/oauth/authorize first.',
    );
    process.exit(1);
  }

  const [cal, usr, cf] = await Promise.allSettled([
    http.get<{ calendars?: Calendar[] }>('/calendars/', { query: { locationId } }),
    http.get<{ users?: User[] }>('/users/', { query: { locationId } }),
    http.get<{ customFields?: CustomField[] }>(`/locations/${locationId}/customFields`),
  ]);

  console.log('\n=== Calendars (HL_CALENDAR_ID) ===');
  if (cal.status === 'fulfilled') {
    for (const c of cal.value.calendars ?? []) console.log(`  ${c.id}  ${c.name ?? ''}`);
  } else console.log(`  (failed: ${cal.reason})`);

  console.log('\n=== Users (HL_CALENDAR_USER_ID / HL_HANDOVER_USER_ID) ===');
  if (usr.status === 'fulfilled') {
    for (const u of usr.value.users ?? [])
      console.log(`  ${u.id}  ${u.name ?? ''} ${u.email ? `<${u.email}>` : ''}`);
  } else console.log(`  (failed: ${usr.reason})`);

  console.log('\n=== Custom fields (HL_FIELD_BUDGET_ID / HL_FIELD_PREFERRED_TIME_ID) ===');
  if (cf.status === 'fulfilled') {
    for (const f of cf.value.customFields ?? [])
      console.log(`  ${f.id}  ${f.name ?? ''}  key=${f.fieldKey ?? ''}  (${f.dataType ?? ''})`);
  } else console.log(`  (failed: ${cf.reason})`);

  console.log('\nCopy the ids above into your .env.\n');
}

void main().catch((err) => {
  console.error('hl:ids failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
