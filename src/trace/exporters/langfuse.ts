import { Langfuse } from 'langfuse';
import { env } from '../../config/env.js';
import { logger } from '../../util/logger.js';
import type { Provenance } from '../../rag/types.js';
import type { TraceExporter } from '../exporter.js';
import type { Trace, TraceStep } from '../types.js';

/** Which KB docs a retrieval step touched — path + score + OKF provenance. */
function sourcesOf(chunks: { docId: string; score: number; provenance?: Provenance }[]): unknown[] {
  return chunks.map((c) => ({
    doc: c.docId,
    path: `kb/${c.docId}.md`,
    score: Math.round(c.score * 1000) / 1000,
    ...(c.provenance && {
      status: c.provenance.status,
      verified: c.provenance.verifiedBy
        ? `${c.provenance.verifiedBy}@${c.provenance.verifiedAt ?? '?'}`
        : undefined,
      freshUntil: c.provenance.staleAfter,
      source: c.provenance.sourceId,
    }),
  }));
}

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

    // Turn-level summary so the trace list answers, at a glance: did this turn
    // use RAG, and if so which docs — vs. an answer the model gave on its own
    // (from the system prompt + conversation history, no retrieval/tools).
    const retrieval = trace.steps.find(
      (s): s is Extract<TraceStep, { type: 'retrieval' }> => s.type === 'retrieval',
    );
    const toolsUsed = trace.steps
      .filter((s): s is Extract<TraceStep, { type: 'tool' }> => s.type === 'tool')
      .map((s) => s.name);
    const ragUsed = Boolean(retrieval);
    const sources = retrieval ? sourcesOf(retrieval.chunks) : [];

    const lfTrace = this.client.trace({
      id: trace.turnId,
      // Name = the decision (knowledge / chitchat / skill:<name> / handover / …)
      // so the Traces list is scannable and filterable, and Langfuse can chart
      // the decision distribution. (Was a hardcoded "agent-turn".)
      name: trace.decision,
      // Group all turns of a conversation into a Session, and segment by contact.
      // Both ids are opaque (not PII) and enable the conversation-replay + per-user views.
      sessionId: trace.conversationId,
      userId: trace.contactId,
      // Tag errors so they're filterable/alertable in the Traces list.
      tags: trace.error ? ['error'] : undefined,
      input: trace.input,
      output: trace.reply,
      metadata: {
        decision: trace.decision,
        // Answer path: which of the three routes the turn took.
        ragUsed,
        grounded: retrieval ? retrieval.grounded : undefined,
        sources, // [{ doc, path, score }] — empty when RAG didn't fire
        toolsUsed, // skill tool names, empty for chit-chat/knowledge
        answeredWithoutRetrievalOrTools: !ragUsed && toolsUsed.length === 0,
        conversationId: trace.conversationId,
        contactId: trace.contactId,
        latencyMs: trace.latencyMs,
        budgetExhausted: trace.budgetExhausted ?? false,
        error: trace.error,
        systemPrompt: trace.system,
      },
    });

    // Number each observation so the tree reads as the orchestrator's loop:
    //   1·llm:decide → 2·retrieval → 3·llm:answer
    let stepNo = 0;
    for (const step of trace.steps) {
      stepNo += 1;
      const startTime = new Date(base + offset);
      const latency = 'latencyMs' in step ? step.latencyMs : 0;
      offset += latency;
      const endTime = new Date(base + offset);

      if (step.type === 'provider_call') {
        lfTrace.generation({
          // "decide" when the model emits tool calls (routes the turn), "answer"
          // when it produces the final reply — so the loop's intent is legible.
          name: `${stepNo}·llm:${step.toolCalls.length ? 'decide' : 'answer'}`,
          model: step.model,
          output: step.text,
          usage: { input: step.usage.inputTokens, output: step.usage.outputTokens, unit: 'TOKENS' },
          startTime,
          endTime,
          metadata: { finishReason: step.finishReason, toolCalls: step.toolCalls },
        });
      } else if (step.type === 'retrieval') {
        const topScore = step.chunks[0]?.score ?? 0;
        lfTrace.span({
          name: `${stepNo}·retrieval:${step.grounded ? 'grounded' : step.reason === 'stale' ? 'stale' : 'no-match'}`,
          input: step.query,
          output: {
            grounded: step.grounded,
            reason: step.reason,
            threshold: env.RAG_SCORE_THRESHOLD,
            sources: sourcesOf(step.chunks), // docs + paths + scores + OKF provenance
            chunks: step.chunks,
          },
          startTime,
          endTime,
          metadata: {
            grounded: step.grounded,
            reason: step.reason,
            threshold: env.RAG_SCORE_THRESHOLD,
            topScore: Math.round(topScore * 1000) / 1000,
            chunkCount: step.chunks.length,
            sources: sourcesOf(step.chunks),
          },
        });
      } else {
        lfTrace.span({
          name: `${stepNo}·tool:${step.name}`,
          input: step.input,
          output: step.output,
          startTime,
          endTime,
          // Failed tool calls surface as ERROR so they're filterable/alertable.
          level: step.ok ? 'DEFAULT' : 'ERROR',
          statusMessage: step.ok ? undefined : `tool ${step.name} failed`,
          metadata: { ok: step.ok },
        });
      }
    }
    // Mark a turn-level failure as an ERROR event so it shows on the trace.
    if (trace.error) {
      lfTrace.event({
        name: 'turn-error',
        level: 'ERROR',
        statusMessage: trace.error,
        startTime: new Date(base + offset),
      });
    }
    // Event creation is fire-and-forget (batched by the SDK). We deliberately do
    // NOT flush per turn — that would drain the whole shared buffer and add a
    // network round-trip to every turn's latency. Draining happens on shutdown().
  }

  async shutdown(): Promise<void> {
    await this.client.shutdownAsync().catch((err) => logger.warn({ err }, 'langfuse shutdown failed'));
  }
}
