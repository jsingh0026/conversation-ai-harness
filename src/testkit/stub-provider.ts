import type {
  GenerateRequest,
  GenerateResult,
  LLMProvider,
  ProviderName,
  StreamChunk,
  ToolCall,
} from '../llm/types.js';

/** A GenerateResult that just returns text (chit-chat / final answer). */
export function textResult(text: string): GenerateResult {
  return { text, toolCalls: [], usage: { inputTokens: 5, outputTokens: 5 }, finishReason: 'stop', raw: {} };
}

/** A GenerateResult that requests tool calls. */
export function toolCallResult(toolCalls: ToolCall[], text: string | null = null): GenerateResult {
  return {
    text,
    toolCalls,
    usage: { inputTokens: 5, outputTokens: 5 },
    finishReason: 'tool-calls',
    raw: {},
  };
}

/**
 * Scripted provider for tests — no network. Pass a fixed sequence of results
 * (consumed one per `generate`) or a function of the request.
 */
export class StubProvider implements LLMProvider {
  readonly name: ProviderName = 'claude';
  readonly model = 'stub-model';
  readonly requests: GenerateRequest[] = [];
  private index = 0;

  constructor(private readonly script: GenerateResult[] | ((req: GenerateRequest) => GenerateResult)) {}

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    // Snapshot messages (the orchestrator mutates one array across calls, so we
    // must capture per-call state, not a shared reference). `tools` holds Zod
    // schemas that aren't structured-cloneable, so keep those by reference.
    this.requests.push({ ...req, messages: structuredClone(req.messages) });
    if (typeof this.script === 'function') return this.script(req);
    const next = this.script[this.index++];
    if (!next) throw new Error('StubProvider script exhausted');
    return next;
  }

  // eslint-disable-next-line require-yield
  async *stream(): AsyncIterable<StreamChunk> {
    throw new Error('StubProvider.stream not implemented');
  }
}
