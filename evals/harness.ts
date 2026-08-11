import { MockCrmClient } from '../src/crm/mock.js';
import type { CalendarSlot } from '../src/crm/types.js';
import type { LLMProvider } from '../src/llm/types.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import type { Retriever } from '../src/rag/retriever.js';
import { createSearchKbTool } from '../src/rag/search-kb.tool.js';
import { createSkills } from '../src/skills/index.js';
import type { ToolStep } from '../src/trace/types.js';

const CAL = 'eval-cal';
let seq = 0;

/** What the eval assertions read off a single turn. */
export interface TurnObservation {
  retrieved: boolean;
  grounded: boolean;
  /** Skill tool names that fired (retrieval is separate; it self-records). */
  firedTools: string[];
  toolInputs: Record<string, unknown>;
  reply: string | null;
  decision: string;
  latencyMs: number;
  budgetExhausted: boolean;
  /** Set when the turn errored OR a tool threw (infra failure) — not a model choice. */
  error?: string;
}

/** A few open slots over the next week so booking flows have something to offer. */
function seedSlots(now: Date): CalendarSlot[] {
  const slots: CalendarSlot[] = [];
  for (let day = 1; day <= 5; day++) {
    for (const hour of [10, 14, 15]) {
      const start = new Date(now);
      start.setDate(start.getDate() + day);
      start.setHours(hour, 0, 0, 0);
      const end = new Date(start.getTime() + 30 * 60_000);
      slots.push({ startTime: start.toISOString(), endTime: end.toISOString() });
    }
  }
  return slots;
}

/**
 * Run one message through a fresh orchestrator (real provider + tools + seeded
 * mock CRM) and distill the trace into assertable facts. Errors are captured,
 * not thrown, so a provider hiccup shows up as an eval error rather than a crash.
 */
export async function runEvalTurn(
  provider: LLMProvider,
  retriever: Retriever,
  message: string,
): Promise<TurnObservation> {
  const now = new Date();
  const crm = new MockCrmClient({ slots: { [CAL]: seedSlots(now) } });
  // Seed a *reachable* contact (name + email) so the booking/handover contact-info
  // gates measure tool routing, not first-turn detail-gathering. (Update-contact
  // cases still exercise the tool — a shared value that differs triggers the
  // conflict path, which is a tool call.)
  crm.upsertContact({ id: 'ct', name: 'Jordan Lee', email: 'jordan.lee@example.com' });

  const tools = [
    createSearchKbTool(retriever),
    ...createSkills({ appointment: { calendarId: CAL } }),
  ];
  const orch = new Orchestrator({ provider, crm, tools, promptVars: { businessName: 'Demo Realty' } });

  const id = `eval-${++seq}`;
  const t0 = Date.now();
  const trace = await orch.runTurn({
    messageId: id,
    conversationId: id,
    contactId: 'ct',
    body: message,
    channel: 'SMS',
    timestamp: now.toISOString(),
  });
  const latencyMs = Date.now() - t0;

  const toolSteps = trace.steps.filter((s): s is ToolStep => s.type === 'tool');
  const retrieval = trace.steps.find((s) => s.type === 'retrieval');
  const toolInputs: Record<string, unknown> = {};
  for (const s of toolSteps) toolInputs[s.name] = s.input;

  return {
    retrieved: Boolean(retrieval),
    grounded: retrieval?.type === 'retrieval' ? retrieval.grounded : false,
    firedTools: toolSteps.map((s) => s.name),
    toolInputs,
    reply: trace.reply,
    decision: trace.decision,
    latencyMs,
    budgetExhausted: Boolean(trace.budgetExhausted),
    // A swallowed tool exception (e.g. missing embedding key) is infra, not behavior.
    error: trace.error ?? (trace.toolError ? 'tool error (infra)' : undefined),
  };
}

export { CAL as EVAL_CALENDAR_ID };
