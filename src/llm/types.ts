import type { z } from 'zod';

/** Provider identifiers understood by the registry. */
export type ProviderName = 'claude' | 'openai' | 'gemini';

/** A tool call the model wants the harness to execute. Normalized across providers. */
export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

/** The result of executing a tool, fed back to the model on the next turn. */
export interface ToolResult {
  toolCallId: string;
  name: string;
  result: unknown;
}

/**
 * Canonical conversation message. Rich enough to represent an assistant turn
 * that requested tools and a tool turn that returned their results, so the
 * orchestrator's tool-use loop can round-trip through any provider.
 */
export type LlmMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolResults: ToolResult[] };

/** A tool the model may call. `parameters` is a Zod schema surfaced to the model. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: z.ZodType;
}

export interface GenerateRequest {
  system?: string;
  messages: LlmMessage[];
  tools?: ToolSpec[];
  toolChoice?: 'auto' | 'required' | 'none';
  temperature?: number;
  maxTokens?: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface GenerateResult {
  /** Final assistant text, or null when the turn was purely tool calls. */
  text: string | null;
  toolCalls: ToolCall[];
  usage: Usage;
  finishReason: string;
  /** Provider-native response, retained for the trace. */
  raw: unknown;
}

/** Incremental output from `stream()`. */
export type StreamChunk =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; toolCall: ToolCall }
  | { type: 'done'; result: GenerateResult };

/**
 * The single seam every LLM call flows through. Implemented once over the
 * Vercel AI SDK; a new provider is a new model handle in the registry, not a
 * new implementation.
 */
export interface LLMProvider {
  readonly name: ProviderName;
  readonly model: string;
  generate(req: GenerateRequest): Promise<GenerateResult>;
  stream(req: GenerateRequest): AsyncIterable<StreamChunk>;
}
