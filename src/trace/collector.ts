import type { GenerateResult, ProviderName } from '../llm/types.js';
import type { RetrievalStep, ToolStep, Trace, TraceDecision, TraceStep } from './types.js';

let seq = 0;
const newTurnId = (): string => `turn_${Date.now().toString(36)}_${(++seq).toString(36)}`;

export interface TraceInit {
  conversationId: string;
  contactId: string;
  input: string;
}

/**
 * Accumulates one turn's steps into a Trace. Pure in-memory — persistence and
 * export (Langfuse / JSON / CLI) are layered on top in Phase 5 via a
 * TraceExporter, so the orchestrator only ever talks to this collector.
 */
export class TraceCollector {
  readonly turnId = newTurnId();
  private readonly startMs = Date.now();
  private readonly startedAt = new Date().toISOString();
  private readonly steps: TraceStep[] = [];
  private system = '';
  private reply: string | null = null;
  private decision: TraceDecision | undefined;
  private error: string | undefined;
  private budgetExhausted = false;

  constructor(private readonly init: TraceInit) {}

  setSystem(system: string): void {
    this.system = system;
  }

  addProviderStep(res: GenerateResult, provider: ProviderName, model: string, latencyMs: number): void {
    this.steps.push({
      type: 'provider_call',
      provider,
      model,
      latencyMs,
      usage: res.usage,
      finishReason: res.finishReason,
      toolCalls: res.toolCalls.map((tc) => ({ name: tc.name, args: tc.args })),
      text: res.text,
    });
  }

  addToolStep(step: Omit<ToolStep, 'type'>): void {
    this.steps.push({ type: 'tool', ...step });
  }

  addRetrievalStep(step: Omit<RetrievalStep, 'type'>): void {
    this.steps.push({ type: 'retrieval', ...step });
  }

  setDecision(decision: TraceDecision): void {
    this.decision = decision;
  }

  setReply(reply: string | null): void {
    this.reply = reply;
  }

  setBudgetExhausted(): void {
    this.budgetExhausted = true;
  }

  setError(message: string): void {
    this.error = message;
    this.decision = 'error';
  }

  /** Finalize into an immutable Trace, computing token totals + latency. */
  finish(): Trace {
    const tokens = this.steps.reduce(
      (acc, s) => {
        if (s.type === 'provider_call') {
          acc.inputTokens += s.usage.inputTokens;
          acc.outputTokens += s.usage.outputTokens;
        }
        return acc;
      },
      { inputTokens: 0, outputTokens: 0 },
    );

    return {
      turnId: this.turnId,
      conversationId: this.init.conversationId,
      contactId: this.init.contactId,
      startedAt: this.startedAt,
      latencyMs: Date.now() - this.startMs,
      input: this.init.input,
      system: this.system,
      decision: this.decision ?? inferDecision(this.steps),
      steps: this.steps,
      tokens,
      reply: this.reply,
      budgetExhausted: this.budgetExhausted || undefined,
      error: this.error,
    };
  }
}

/** Infer the headline decision from which tools fired, when not set explicitly. */
export function inferDecision(steps: TraceStep[]): TraceDecision {
  const toolNames = steps.filter((s): s is ToolStep => s.type === 'tool').map((s) => s.name);
  if (toolNames.length === 0) return 'chitchat';
  if (toolNames.includes('request_human_handover')) return 'handover';
  if (toolNames.includes('search_knowledge_base')) return 'knowledge';
  return `skill:${toolNames[0]}`;
}
