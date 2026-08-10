import type { Trace, TraceStep } from '../trace/types.js';

/**
 * PII masking for observability sinks (logs + traces) — NOT for LLM input, which
 * needs the real values to drive the skills. Masks emails and phone numbers in
 * free text while keeping enough for correlation/debugging (`ja***@gmail.com`,
 * `***67`). Patterns are bounded (no nested quantifiers) to avoid catastrophic
 * backtracking on the logging hot path, with a length guard as defence in depth.
 */
const MAX_LEN = 8192;

// Group 1 = first local-part char, group 2 = `@domain`; the domain is a series of
// bounded dot-separated labels (not one `[...]+` spanning dots), so it's linear.
const EMAIL_RE = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{0,63}(@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,10})/g;

// E.164 (`+` then 8–15 digits) or a separator-formatted 10-digit number. Bounded.
const PHONE_RE = /\+\d{8,15}\b|(?:\+\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;

function maskPhone(match: string): string {
  const digits = match.replace(/\D/g, '');
  return digits.length >= 7 ? `***${digits.slice(-2)}` : match;
}

/** Mask emails + phone numbers in a single string. */
export function redactPii(text: string): string {
  if (!text || text.length > MAX_LEN) return text;
  return text
    .replace(EMAIL_RE, (_m, first: string, domain: string) => `${first}***${domain}`)
    .replace(PHONE_RE, maskPhone);
}

/** Recursively mask PII in any JSON-ish value (strings masked, structure kept). */
export function redactDeep(value: unknown, depth = 0): unknown {
  if (depth > 8) return value;
  if (typeof value === 'string') return redactPii(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, depth + 1);
    return out;
  }
  return value;
}

function redactStep(step: TraceStep): TraceStep {
  switch (step.type) {
    case 'provider_call':
      return {
        ...step,
        text: step.text === null ? null : redactPii(step.text),
        toolCalls: step.toolCalls.map((t) => ({ ...t, args: redactDeep(t.args) })),
      };
    case 'tool':
      return { ...step, input: redactDeep(step.input), output: redactDeep(step.output) };
    case 'retrieval':
      return {
        ...step,
        query: redactPii(step.query),
        chunks: step.chunks.map((c) => ({ ...c, text: redactPii(c.text) })),
      };
  }
}

/**
 * Return a PII-masked copy of a trace for export. Applied once before fan-out so
 * every exporter (Langfuse, JSON file) sees masked data; the live in-memory
 * trace is untouched.
 */
export function redactTrace(trace: Trace): Trace {
  return {
    ...trace,
    input: redactPii(trace.input),
    system: redactPii(trace.system),
    reply: trace.reply === null ? null : redactPii(trace.reply),
    steps: trace.steps.map(redactStep),
  };
}
