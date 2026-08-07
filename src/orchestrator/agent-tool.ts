import type { CrmClient } from '../crm/types.js';
import type { ToolSpec } from '../llm/types.js';
import type { TraceCollector } from '../trace/collector.js';

/** Everything a tool/skill needs to do its work and record what it did. */
export interface ToolContext {
  conversationId: string;
  contactId: string;
  crm: CrmClient;
  trace: TraceCollector;
}

/**
 * An executable tool the model can call. RAG retrieval (Phase 3) and every
 * skill (Phase 4) implement this shape, so the orchestrator dispatches them
 * uniformly. Adding one is registration, not a change to the loop.
 */
export interface AgentTool<Args = unknown, Out = unknown> {
  readonly spec: ToolSpec;
  run(args: Args, ctx: ToolContext): Promise<Out>;
}

/** Index a tool list by name for dispatch, erroring on duplicate names. */
export function indexTools(tools: AgentTool[]): Map<string, AgentTool> {
  const byName = new Map<string, AgentTool>();
  for (const t of tools) {
    if (byName.has(t.spec.name)) throw new Error(`Duplicate tool name: ${t.spec.name}`);
    byName.set(t.spec.name, t);
  }
  return byName;
}
