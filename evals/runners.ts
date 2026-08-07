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

/** An errored turn is infra, not behavior: it's a failure and is excluded from metrics. */
function erroredFailure<C extends { id: string; message: string }>(
  c: C,
  error: string,
): CaseResult {
  return { id: c.id, pass: false, detail: `infra error: ${error} — "${c.message}"` };
}

export async function runRagTrigger(
  provider: LLMProvider,
  retriever: Retriever,
  cases: RagCase[],
): Promise<SuiteResult> {
  const rows = await observeAll(provider, retriever, cases);
  const failures: CaseResult[] = [];
  const scored: { pred: boolean; actual: boolean }[] = [];

  for (const { c, obs } of rows) {
    if (obs.error) {
      failures.push(erroredFailure(c, obs.error));
      continue;
    }
    const pass = obs.retrieved === c.shouldRetrieve;
    if (!pass)
      failures.push({
        id: c.id,
        pass,
        detail: `expected retrieve=${c.shouldRetrieve}, got ${obs.retrieved} — "${c.message}"`,
      });
    scored.push({ pred: obs.retrieved, actual: c.shouldRetrieve });
  }

  const conf = confusionOf(scored);
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
    if (obs.error) {
      failures.push(erroredFailure(c, obs.error));
      continue;
    }
    let pass: boolean;
    let detail: string;
    if (c.expect === 'grounded') {
      grounded++;
      pass = obs.retrieved && obs.grounded && groundedPass(obs.reply, c.expectedFacts);
      if (pass) groundedPassed++;
      detail = `grounded expected facts ${JSON.stringify(c.expectedFacts)} — reply: "${obs.reply ?? ''}"`;
    } else {
      declined++;
      pass = declinePass(obs.reply, obs.decision, obs.budgetExhausted);
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
  const scored: { pred: boolean; actual: boolean }[] = [];

  for (const { c, obs } of rows) {
    if (obs.error) {
      failures.push(erroredFailure(c, obs.error));
      continue;
    }
    const shouldFire = c.expectSkill === targetSkill;
    const didFire = obs.firedTools.includes(targetSkill);

    // For positive extraction cases, missing expected fields is a miss (not a
    // clean fire), so it counts against recall — not as a true positive.
    if (shouldFire && didFire && c.expectedFields?.length) {
      const input = (obs.toolInputs[targetSkill] ?? {}) as Record<string, unknown>;
      const missing = c.expectedFields.filter((f) => input[f] === undefined);
      if (missing.length) {
        failures.push({
          id: c.id,
          pass: false,
          detail: `fired but missing fields ${JSON.stringify(missing)} — got ${JSON.stringify(input)}`,
        });
        scored.push({ pred: false, actual: true });
        continue;
      }
    }

    const pass = shouldFire === didFire;
    if (!pass)
      failures.push({
        id: c.id,
        pass,
        detail: `expected ${targetSkill}=${shouldFire}, got ${didFire} — "${c.message}"`,
      });
    scored.push({ pred: didFire, actual: shouldFire });
  }

  const conf = confusionOf(scored);
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
  const errors = countErrors(rows);
  const latencies = rows.filter((r) => !r.obs.error).map((r) => r.obs.latencyMs);
  const failures: CaseResult[] = [];

  // A run with no successful turns can't be "green" — surface it loudly.
  if (latencies.length === 0) {
    failures.push({ id: 'no-data', pass: false, detail: 'all latency turns errored' });
    return {
      suite: 'latency',
      provider: provider.name,
      total: messages.length,
      passed: 0,
      metrics: { p50: 0, p95: 0, mean: 0 },
      failures,
      errors,
    };
  }

  const p50 = percentile(latencies, 50);
  const p95 = percentile(latencies, 95);
  const mean = latencies.reduce((a, b) => a + b, 0) / latencies.length;

  // Targets from the spec: p50 ≤ 3s, p95 ≤ 6s (non-RAG turns).
  if (p50 > 3000) failures.push({ id: 'p50', pass: false, detail: `p50 ${p50}ms > 3000ms target` });
  if (p95 > 6000) failures.push({ id: 'p95', pass: false, detail: `p95 ${p95}ms > 6000ms target` });
  if (errors > 0) failures.push({ id: 'errors', pass: false, detail: `${errors} turn(s) errored` });

  return {
    suite: 'latency',
    provider: provider.name,
    total: messages.length,
    passed: latencies.filter((ms) => ms <= 6000).length,
    metrics: { p50, p95, mean: Math.round(mean) },
    failures,
    errors,
  };
}
