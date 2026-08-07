import { Langfuse } from 'langfuse';
import { logger } from '../../util/logger.js';
import type { TraceExporter } from '../exporter.js';
import type { Trace } from '../types.js';

export interface LangfuseConfig {
  publicKey: string;
  secretKey: string;
  baseUrl?: string;
}

/**
 * Exports a turn to Langfuse: the turn becomes a trace, each LLM call a
 * `generation` (model + tokens), and each retrieval/tool a `span` (inputs,
 * outputs, retrieval chunks + scores). Opt-in — only constructed when
 * LANGFUSE_* keys are present. Never throws into the turn.
 */
export class LangfuseExporter implements TraceExporter {
  readonly name = 'langfuse';
  private readonly client: Langfuse;

  constructor(config: LangfuseConfig) {
    this.client = new Langfuse({
      publicKey: config.publicKey,
      secretKey: config.secretKey,
      baseUrl: config.baseUrl,
    });
  }

  async export(trace: Trace): Promise<void> {
    const base = Date.parse(trace.startedAt);
    let offset = 0;

    const lfTrace = this.client.trace({
      id: trace.turnId,
      name: 'agent-turn',
      input: trace.input,
      output: trace.reply,
      metadata: {
        decision: trace.decision,
        conversationId: trace.conversationId,
        contactId: trace.contactId,
        latencyMs: trace.latencyMs,
        budgetExhausted: trace.budgetExhausted ?? false,
        error: trace.error,
        systemPrompt: trace.system,
      },
    });

    for (const step of trace.steps) {
      const startTime = new Date(base + offset);
      const latency = 'latencyMs' in step ? step.latencyMs : 0;
      offset += latency;
      const endTime = new Date(base + offset);

      if (step.type === 'provider_call') {
        lfTrace.generation({
          name: `llm:${step.provider}`,
          model: step.model,
          output: step.text,
          usage: { input: step.usage.inputTokens, output: step.usage.outputTokens, unit: 'TOKENS' },
          startTime,
          endTime,
          metadata: { finishReason: step.finishReason, toolCalls: step.toolCalls },
        });
      } else if (step.type === 'retrieval') {
        lfTrace.span({
          name: 'retrieval',
          input: step.query,
          output: { grounded: step.grounded, chunks: step.chunks },
          startTime,
          endTime,
          metadata: { grounded: step.grounded, chunkCount: step.chunks.length },
        });
      } else {
        lfTrace.span({
          name: `tool:${step.name}`,
          input: step.input,
          output: step.output,
          startTime,
          endTime,
          metadata: { ok: step.ok },
        });
      }
    }
    // Event creation is fire-and-forget (batched by the SDK). We deliberately do
    // NOT flush per turn — that would drain the whole shared buffer and add a
    // network round-trip to every turn's latency. Draining happens on shutdown().
  }

  async shutdown(): Promise<void> {
    await this.client.shutdownAsync().catch((err) => logger.warn({ err }, 'langfuse shutdown failed'));
  }
}
