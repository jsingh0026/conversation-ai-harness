import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { env } from '../config/env.js';
import { logger } from '../util/logger.js';
import type { Trace } from './types.js';

const TRACE_DIR = join(process.cwd(), 'traces');

/**
 * Persist a trace as JSON (one file per turn) and log a one-line summary.
 * This is the always-on fallback surface; Phase 5 adds the Langfuse exporter
 * behind a TraceExporter seam and a CLI viewer over these files.
 */
export async function emitTrace(trace: Trace): Promise<void> {
  logger.info(
    {
      turnId: trace.turnId,
      decision: trace.decision,
      latencyMs: trace.latencyMs,
      tokens: trace.tokens.inputTokens + trace.tokens.outputTokens,
      steps: trace.steps.length,
    },
    'turn complete',
  );

  if (env.NODE_ENV === 'test') return;

  try {
    await mkdir(TRACE_DIR, { recursive: true });
    await writeFile(join(TRACE_DIR, `${trace.turnId}.json`), JSON.stringify(trace, null, 2));
  } catch (err) {
    // Tracing must never break a turn.
    logger.warn({ err }, 'failed to persist trace');
  }
}
