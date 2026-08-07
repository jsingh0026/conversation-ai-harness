import { logger } from '../../util/logger.js';
import type { TraceExporter } from '../exporter.js';
import type { Trace } from '../types.js';

/** Logs a one-line summary of each turn to the operational log. */
export class ConsoleSummaryExporter implements TraceExporter {
  readonly name = 'console';

  async export(trace: Trace): Promise<void> {
    logger.info(
      {
        turnId: trace.turnId,
        decision: trace.decision,
        latencyMs: trace.latencyMs,
        tokens: trace.tokens.inputTokens + trace.tokens.outputTokens,
        steps: trace.steps.length,
        budgetExhausted: trace.budgetExhausted,
        error: trace.error,
      },
      'turn complete',
    );
  }
}
