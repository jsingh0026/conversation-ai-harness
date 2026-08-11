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

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Match one fact against a reply with boundaries, so `5%` doesn't match `15%`,
 * `9` doesn't match `1996`, and `free` doesn't match `freedom`. Percentages are
 * matched numerically (not as a substring of a bigger number).
 */
export function factMatches(lowerReply: string, alt: string): boolean {
  const a = alt.trim().toLowerCase();
  if (!a) return false;
  if (a.endsWith('%')) {
    const num = a.slice(0, -1);
    return new RegExp(`(?<![\\d.])${escapeRe(num)}%`).test(lowerReply);
  }
  // Word-ish boundary for simple alphanumeric tokens (allow spaces, ., ', -).
  if (/^[a-z0-9][a-z0-9 .'-]*$/.test(a)) {
    return new RegExp(`(?<![a-z0-9])${escapeRe(a)}(?![a-z0-9])`).test(lowerReply);
  }
  return lowerReply.includes(a);
}

/** Grounded passes if every expected fact (each may be `a|b` alternatives) matches with boundaries. */
export function groundedPass(reply: string | null, expectedFacts: string[] = []): boolean {
  if (!reply) return false;
  const low = reply.toLowerCase();
  return expectedFacts.every((fact) => fact.split('|').some((alt) => factMatches(low, alt)));
}

/** A specific price/rate figure the agent shouldn't have invented for an out-of-KB question. */
export const FABRICATION_RE = /\$\s?\d|\d+(\.\d+)?\s?%/;

/**
 * A decline passes if the agent handed over, said nothing, or answered WITHOUT
 * asserting a specific fabricated figure ($ amount / percentage). A generic
 * fallback/budget-exhausted reply is NOT a valid decline — that's a failure, not
 * a deliberate "I don't have that". (Heuristic; documented as such in the README.)
 */
/** Digits of a money/number token, with a trailing `k` expanded (400k → 400000). */
const numKey = (s: string): string => s.toLowerCase().replace(/k/g, '000').replace(/[^0-9]/g, '');

export function declinePass(
  reply: string | null,
  decision: string,
  budgetExhausted = false,
  query = '',
): boolean {
  if (decision === 'handover' || decision === 'bot_disabled') return true;
  if (budgetExhausted) return false;
  if (!reply) return true;
  if (!FABRICATION_RE.test(reply)) return true;
  // The reply contains a figure — allow it only if EVERY $-figure just echoes a
  // number the customer themselves stated (e.g. declining "3-beds under $400k" by
  // repeating $400k). A percentage or a figure not in the query = fabrication.
  if (/\d+(\.\d+)?\s?%/.test(reply)) return false; // never echo a rate on a decline
  const queryNums = new Set((query.match(/\$?\s?\d[\d,]*\s?k?/gi) ?? []).map(numKey).filter(Boolean));
  const replyFigs = (reply.match(/\$\s?\d[\d,]*\s?k?/gi) ?? []).map(numKey).filter(Boolean);
  if (replyFigs.length === 0) return false;
  return replyFigs.every((f) => [...queryNums].some((q) => q && (f.includes(q) || q.includes(f))));
}
