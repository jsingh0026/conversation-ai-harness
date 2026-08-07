import { env } from '../config/env.js';
import { createHighLevelClient } from './highlevel/index.js';
import { MockCrmClient } from './mock.js';
import type { CrmClient } from './types.js';

export * from './types.js';
export { SlotTakenError } from './errors.js';
export { MockCrmClient } from './mock.js';

/**
 * Resolve the CRM client from config. The real HighLevel client lands in Phase 7;
 * until then `CRM_MODE=highlevel` fails fast rather than silently mocking.
 */
export function createCrmClient(): CrmClient {
  switch (env.CRM_MODE) {
    case 'mock':
      return new MockCrmClient();
    case 'highlevel':
      // Reads HL_* env lazily inside; throws a clear error if unconfigured.
      return createHighLevelClient();
    default:
      throw new Error(`Unknown CRM_MODE: ${String(env.CRM_MODE)}`);
  }
}
