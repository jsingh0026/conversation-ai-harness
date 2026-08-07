import { createProvider } from '../providers/registry.js';
import type { CrmClient } from '../crm/types.js';
import type { AgentTool } from './agent-tool.js';
import { ConversationStore } from './history.js';
import { IdempotencyStore } from './idempotency.js';
import { Orchestrator } from './orchestrator.js';
import { KeyedQueue } from './queue.js';

export { Orchestrator } from './orchestrator.js';
export { IdempotencyStore } from './idempotency.js';
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

/** Build the default stack for a given CRM. Tools are registered in later phases. */
export function createOrchestratorStack(
  crm: CrmClient,
  tools: AgentTool[] = [],
): OrchestratorStack {
  const history = new ConversationStore();
  const orchestrator = new Orchestrator({ provider: createProvider(), crm, tools, history });
  return { orchestrator, queue: new KeyedQueue(), idempotency: new IdempotencyStore(), history };
}
