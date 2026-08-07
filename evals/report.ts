import type { SuiteResult } from './types.js';

const pct = (n: number): string => `${(n * 100).toFixed(0)}%`;

/** One-line headline metric per suite for the summary table. */
function headline(r: SuiteResult): string {
  switch (r.suite) {
    case 'rag-trigger':
      return `P ${pct(r.metrics.precision ?? 0)} / R ${pct(r.metrics.recall ?? 0)}`;
    case 'groundedness':
      return `grounded ${pct(r.metrics.groundedAccuracy ?? 0)} / decline ${pct(r.metrics.declineAccuracy ?? 0)}`;
    case 'latency':
      return `p50 ${r.metrics.p50 ?? 0}ms / p95 ${r.metrics.p95 ?? 0}ms`;
    default:
      return `P ${pct(r.metrics.precision ?? 0)} / R ${pct(r.metrics.recall ?? 0)}`;
  }
}

/** Render the full report: a per-provider table plus a failure breakdown. */
export function renderReport(results: SuiteResult[]): string {
  const lines: string[] = [];
  const providers = [...new Set(results.map((r) => r.provider))];

  lines.push('\n══════════════════════════ EVAL RESULTS ══════════════════════════\n');

  for (const provider of providers) {
    lines.push(`● ${provider}`);
    lines.push(
      `  ${'suite'.padEnd(20)} ${'pass'.padEnd(9)} ${'errors'.padEnd(7)} headline`,
    );
    for (const r of results.filter((x) => x.provider === provider)) {
      const pass = `${r.passed}/${r.total}`;
      lines.push(
        `  ${r.suite.padEnd(20)} ${pass.padEnd(9)} ${String(r.errors).padEnd(7)} ${headline(r)}`,
      );
    }
    lines.push('');
  }

  const withFailures = results.filter((r) => r.failures.length > 0);
  if (withFailures.length > 0) {
    lines.push('───────────────────────────── FAILURES ─────────────────────────────\n');
    for (const r of withFailures) {
      lines.push(`▸ ${r.provider} / ${r.suite} (${r.failures.length})`);
      for (const f of r.failures) lines.push(`    ✗ ${f.id}: ${f.detail ?? ''}`);
      lines.push('');
    }
  } else {
    lines.push('No failures. 🎉\n');
  }

  return lines.join('\n');
}
