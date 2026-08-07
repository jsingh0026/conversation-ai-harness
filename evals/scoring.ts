/** Pure scoring helpers for the eval suite (unit-tested, no I/O). */

export interface Confusion {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
}

export function confusionOf(rows: { pred: boolean; actual: boolean }[]): Confusion {
  const c: Confusion = { tp: 0, fp: 0, fn: 0, tn: 0 };
  for (const { pred, actual } of rows) {
    if (pred && actual) c.tp++;
    else if (pred && !actual) c.fp++;
    else if (!pred && actual) c.fn++;
    else c.tn++;
  }
  return c;
}

export const precision = (c: Confusion): number => (c.tp + c.fp === 0 ? 1 : c.tp / (c.tp + c.fp));
export const recall = (c: Confusion): number => (c.tp + c.fn === 0 ? 1 : c.tp / (c.tp + c.fn));
export const f1 = (p: number, r: number): number => (p + r === 0 ? 0 : (2 * p * r) / (p + r));

/** Nearest-rank percentile (p in 0–100). */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx]!;
}

/** Phrases that indicate the agent declined rather than fabricating an answer. */
export const DECLINE_RE =
  /(don'?t|do not) have|not (sure|able)|can'?t (help|assist|find)|cannot|reach out|team member|out of scope|isn'?t something|don'?t currently|unable|no information|not able to/i;

/** A grounded answer passes if every expected fact (each may be `a|b` alternatives) appears. */
export function groundedPass(reply: string | null, expectedFacts: string[] = []): boolean {
  if (!reply) return false;
  const low = reply.toLowerCase();
  return expectedFacts.every((fact) =>
    fact
      .toLowerCase()
      .split('|')
      .some((alt) => low.includes(alt.trim())),
  );
}

/** A decline passes if the agent handed over or produced no confident fabricated answer. */
export function declinePass(reply: string | null, decision: string): boolean {
  if (decision === 'handover' || decision === 'bot_disabled') return true;
  if (!reply) return true;
  return DECLINE_RE.test(reply);
}
