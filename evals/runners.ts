import type { LLMProvider } from '../src/llm/types.js';
import type { Retriever } from '../src/rag/retriever.js';
import { runEvalTurn, type TurnObservation } from './harness.js';
import {
  confusionOf,
  declinePass,
  f1,
  groundedPass,
  percentile,
  precision,
  recall,
} from './scoring.js';
import type { CaseResult, SuiteResult } from './types.js';

export interface RagCase {
  id: string;
  message: string;
  shouldRetrieve: boolean;
}
export interface GroundCase {
  id: string;
  message: string;
  expect: 'grounded' | 'decline';
  expectedFacts?: string[];
}
export interface SkillCase {
  id: string;
  message: string;
  expectSkill: string | null;
  expectedFields?: string[];
}

/** Run `fn` over items with bounded concurrency, preserving input order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const CONCURRENCY = 4;

interface Observed<C> {
  c: C;
  obs: TurnObservation;
}

async function observeAll<C extends { message: string }>(
  provider: LLMProvider,
  retriever: Retriever,
  cases: C[],
): Promise<Observed<C>[]> {
  return mapLimit(cases, CONCURRENCY, async (c) => ({
    c,
    obs: await runEvalTurn(provider, retriever, c.message),
  }));
}

const countErrors = <C>(rows: Observed<C>[]): number => rows.filter((r) => r.obs.error).length;

export async function runRagTrigger(
  provider: LLMProvider,
  retriever: Retriever,
  cases: RagCase[],
): Promise<SuiteResult> {
  const rows = await observeAll(provider, retriever, cases);
  const failures: CaseResult[] = [];
  const conf = confusionOf(
    rows.map(({ c, obs }) => {
      const pass = obs.retrieved === c.shouldRetrieve;
      if (!pass)
        failures.push({
          id: c.id,
          pass,
          detail: `expected retrieve=${c.shouldRetrieve}, got ${obs.retrieved} — "${c.message}"`,
        });
      return { pred: obs.retrieved, actual: c.shouldRetrieve };
    }),
  );
  const p = precision(conf);
  const r = recall(conf);
  return {
    suite: 'rag-trigger',
    provider: provider.name,
    total: cases.length,
    passed: cases.length - failures.length,
    metrics: { precision: p, recall: r, f1: f1(p, r) },
    failures,
    errors: countErrors(rows),
  };
}

export async function runGroundedness(
  provider: LLMProvider,
  retriever: Retriever,
  cases: GroundCase[],
): Promise<SuiteResult> {
  const rows = await observeAll(provider, retriever, cases);
  const failures: CaseResult[] = [];
  let grounded = 0;
  let declined = 0;
  let groundedPassed = 0;
  let declinedPassed = 0;

  for (const { c, obs } of rows) {
    let pass: boolean;
    let detail: string;
    if (c.expect === 'grounded') {
      grounded++;
      pass = obs.retrieved && obs.grounded && groundedPass(obs.reply, c.expectedFacts);
      if (pass) groundedPassed++;
      detail = `grounded expected facts ${JSON.stringify(c.expectedFacts)} — reply: "${obs.reply ?? ''}"`;
    } else {
      declined++;
      pass = declinePass(obs.reply, obs.decision);
      if (pass) declinedPassed++;
      detail = `should decline — reply: "${obs.reply ?? ''}"`;
    }
    if (!pass) failures.push({ id: c.id, pass, detail });
  }

  return {
    suite: 'groundedness',
    provider: provider.name,
    total: cases.length,
    passed: cases.length - failures.length,
    metrics: {
      groundedAccuracy: grounded ? groundedPassed / grounded : 1,
      declineAccuracy: declined ? declinedPassed / declined : 1,
    },
    failures,
    errors: countErrors(rows),
  };
}

export async function runSkill(
  provider: LLMProvider,
  retriever: Retriever,
  cases: SkillCase[],
  targetSkill: string,
  suiteName: string,
): Promise<SuiteResult> {
  const rows = await observeAll(provider, retriever, cases);
  const failures: CaseResult[] = [];

  const conf = confusionOf(
    rows.map(({ c, obs }) => {
      const shouldFire = c.expectSkill === targetSkill;
      const didFire = obs.firedTools.includes(targetSkill);
      let pass = shouldFire === didFire;

      // For positive extraction cases, also require the expected fields.
      if (pass && shouldFire && c.expectedFields?.length) {
        const input = (obs.toolInputs[targetSkill] ?? {}) as Record<string, unknown>;
        const missing = c.expectedFields.filter((f) => input[f] === undefined);
        if (missing.length) {
          pass = false;
          failures.push({
            id: c.id,
            pass,
            detail: `fired but missing fields ${JSON.stringify(missing)} — got ${JSON.stringify(input)}`,
          });
          return { pred: didFire, actual: shouldFire };
        }
      }
      if (!pass)
        failures.push({
          id: c.id,
          pass,
          detail: `expected ${targetSkill}=${shouldFire}, got ${didFire} — "${c.message}"`,
        });
      return { pred: didFire, actual: shouldFire };
    }),
  );
  const p = precision(conf);
  const r = recall(conf);
  return {
    suite: suiteName,
    provider: provider.name,
    total: cases.length,
    passed: cases.length - failures.length,
    metrics: { precision: p, recall: r, f1: f1(p, r) },
    failures,
    errors: countErrors(rows),
  };
}

/** Non-RAG chit-chat used to benchmark webhook-to-send latency. */
export const LATENCY_MESSAGES = [
  'Hi there!',
  'Good morning',
  'Thanks so much, that helps',
  'Hello, is anyone there?',
  'Appreciate it!',
  'Hey!',
  'Have a great day',
  'Ok sounds good',
];

export async function runLatency(
  provider: LLMProvider,
  retriever: Retriever,
  messages: string[] = LATENCY_MESSAGES,
): Promise<SuiteResult> {
  const rows = await observeAll(
    provider,
    retriever,
    messages.map((m, i) => ({ id: `lat-${i}`, message: m })),
  );
  const latencies = rows.filter((r) => !r.obs.error).map((r) => r.obs.latencyMs);
  const p50 = percentile(latencies, 50);
  const p95 = percentile(latencies, 95);
  const mean = latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;

  // Targets from the spec: p50 ≤ 3s, p95 ≤ 6s (non-RAG turns).
  const failures: CaseResult[] = [];
  if (p50 > 3000) failures.push({ id: 'p50', pass: false, detail: `p50 ${p50}ms > 3000ms target` });
  if (p95 > 6000) failures.push({ id: 'p95', pass: false, detail: `p95 ${p95}ms > 6000ms target` });

  return {
    suite: 'latency',
    provider: provider.name,
    total: messages.length,
    passed: latencies.length,
    metrics: { p50, p95, mean: Math.round(mean) },
    failures,
    errors: countErrors(rows),
  };
}
