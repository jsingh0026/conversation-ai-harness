import { generateText, streamText, type LanguageModel } from 'ai';
import { mapProviderError } from '../llm/errors.js';
import { withRetry } from '../llm/retry.js';
import type {
  GenerateRequest,
  GenerateResult,
  LLMProvider,
  ProviderName,
  StreamChunk,
  ToolCall,
} from '../llm/types.js';
import { logger } from '../util/logger.js';
import { toModelMessages, toToolSet } from './messages.js';

/** Cross-version-safe read of the SDK's usage shape. */
function readUsage(usage: unknown): { inputTokens: number; outputTokens: number } {
  const u = (usage ?? {}) as Record<string, number | undefined>;
  return {
    inputTokens: u.inputTokens ?? u.promptTokens ?? 0,
    outputTokens: u.outputTokens ?? u.completionTokens ?? 0,
  };
}

/** Normalize an SDK tool call (whose arg field name has drifted across versions). */
function readToolCall(tc: unknown): ToolCall {
  const c = tc as { toolCallId: string; toolName: string; input?: unknown; args?: unknown };
  return { id: c.toolCallId, name: c.toolName, args: c.input ?? c.args };
}

/**
 * The one LLMProvider implementation. All three providers are the same code
 * with a different AI SDK model handle — that's the point of the abstraction.
 * `generate()` maps SDK errors to typed errors and retries the retryable ones.
 * `stream()` maps errors too but does NOT retry (a partial stream can't be
 * transparently replayed); prefer `generate()` where resilience matters.
 */
export class AiSdkProvider implements LLMProvider {
  constructor(
    readonly name: ProviderName,
    readonly model: string,
    private readonly handle: LanguageModel,
  ) {}

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const tools = toToolSet(req.tools);
    return withRetry(
      async () => {
        try {
          const res = await generateText({
            model: this.handle,
            system: req.system,
            messages: toModelMessages(req.messages),
            tools,
            // Only send toolChoice when tools exist; otherwise the SDK warns.
            toolChoice: tools ? req.toolChoice : undefined,
            temperature: req.temperature,
            maxOutputTokens: req.maxTokens,
          });
          return {
            text: res.text ? res.text : null,
            toolCalls: (res.toolCalls ?? []).map(readToolCall),
            usage: readUsage(res.usage),
            finishReason: res.finishReason,
            raw: res,
          } satisfies GenerateResult;
        } catch (err) {
          throw mapProviderError(err, this.name);
        }
      },
      {
        onRetry: (attempt, delayMs, err) =>
          logger.warn(
            { provider: this.name, attempt, delayMs, err: err.name },
            'retrying LLM call',
          ),
      },
    );
  }

  async *stream(req: GenerateRequest): AsyncIterable<StreamChunk> {
    const tools = toToolSet(req.tools);
    const res: ReturnType<typeof streamText> = streamText({
      model: this.handle,
      system: req.system,
      messages: toModelMessages(req.messages),
      tools,
      toolChoice: tools ? req.toolChoice : undefined,
      temperature: req.temperature,
      maxOutputTokens: req.maxTokens,
    });

    // Note: res.textStream does NOT surface provider errors — a failed call
    // rejects the settled promises below instead, which is where we map it.
    for await (const delta of res.textStream) {
      yield { type: 'text', text: delta };
    }

    try {
      const [text, toolCalls, usage, finishReason] = await Promise.all([
        res.text,
        res.toolCalls,
        res.usage,
        res.finishReason,
      ]);
      const normalizedCalls = (toolCalls ?? []).map(readToolCall);
      for (const tc of normalizedCalls) yield { type: 'tool-call', toolCall: tc };
      // A mid-stream failure after a step started resolves with finishReason
      // 'error' rather than rejecting; consumers of `done` should check it.
      yield {
        type: 'done',
        result: {
          text: text ? text : null,
          toolCalls: normalizedCalls,
          usage: readUsage(usage),
          finishReason,
          raw: res,
        },
      };
    } catch (err) {
      throw mapProviderError(err, this.name);
    }
  }
}
