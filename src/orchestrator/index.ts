import { createProvider } from '../providers/registry.js';
import { getPool } from '../config/db.js';
import { env, isDbEnabled } from '../config/env.js';
import { logger } from '../util/logger.js';
import type { CrmClient } from '../crm/types.js';
import type { SystemPromptVars } from '../prompts/system.js';
import type { AgentTool } from './agent-tool.js';
import { ConversationStore } from './history.js';
import { MemoryIdempotencyStore, type IdempotencyStore } from './idempotency.js';
import { PgIdempotencyStore } from './pg-idempotency.js';
import { Orchestrator } from './orchestrator.js';
import { KeyedQueue } from './queue.js';

export { Orchestrator } from './orchestrator.js';
export { MemoryIdempotencyStore, type IdempotencyStore } from './idempotency.js';
export { PgIdempotencyStore } from './pg-idempotency.js';
export { KeyedQueue } from './queue.js';
export { ConversationStore } from './history.js';
export type { AgentTool, ToolContext } from './agent-tool.js';

/**
 * The runtime pieces the server wires together: the orchestrator plus the
 * webhook-facing idempotency store and per-conversation queue.
 */
export interface OrchestratorStack {
  orchestrator: Orchestrator;
  queue: KeyedQueue;
  idempotency: IdempotencyStore;
  history: ConversationStore;
}

/** Build the default stack for a given CRM, with the given tools + prompt vars. */
export function createOrchestratorStack(
  crm: CrmClient,
  tools: AgentTool[] = [],
  promptVars: SystemPromptVars = {},
): OrchestratorStack {
  const history = new ConversationStore(40, env.HISTORY_IDLE_RESET_MIN * 60 * 1000);
  const orchestrator = new Orchestrator({ provider: createProvider(), crm, tools, history, promptVars });
  const idempotency: IdempotencyStore = isDbEnabled
    ? new PgIdempotencyStore(getPool())
    : new MemoryIdempotencyStore();
  logger.info({ backend: isDbEnabled ? 'postgres' : 'memory' }, 'idempotency store selected');
  return { orchestrator, queue: new KeyedQueue(), idempotency, history };
}
