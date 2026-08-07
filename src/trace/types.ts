import type { ProviderName } from '../llm/types.js';

/** What the harness decided to do on a turn — the headline of the trace. */
export type TraceDecision =
  | 'chitchat'
  | 'knowledge'
  | `skill:${string}`
  | 'handover'
  | 'bot_disabled'
  | 'error';

/** One LLM call within a turn. */
export interface ProviderStep {
  type: 'provider_call';
  provider: ProviderName;
  model: string;
  latencyMs: number;
  usage: { inputTokens: number; outputTokens: number };
  finishReason: string;
  /** Names + args of tool calls the model requested (if any). */
  toolCalls: { name: string; args: unknown }[];
  text: string | null;
}

/** One tool/skill execution within a turn. */
export interface ToolStep {
  type: 'tool';
  name: string;
  input: unknown;
  output: unknown;
  latencyMs: number;
  ok: boolean;
}

/** A retrieval against the knowledge base (Phase 3 populates chunks + scores). */
export interface RetrievalStep {
  type: 'retrieval';
  query: string;
  latencyMs: number;
  chunks: { docId: string; score: number; text: string }[];
  grounded: boolean;
}

export type TraceStep = ProviderStep | ToolStep | RetrievalStep;

/**
 * The full, inspectable record of one turn. Answers "why did the agent say
 * that?" — the assembled system prompt, every provider/tool step with latency
 * and tokens, the decision, and the final reply.
 */
export interface Trace {
  turnId: string;
  conversationId: string;
  contactId: string;
  startedAt: string;
  latencyMs: number;
  input: string;
  system: string;
  decision: TraceDecision;
  steps: TraceStep[];
  tokens: { inputTokens: number; outputTokens: number };
  reply: string | null;
  error?: string;
}
