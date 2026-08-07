import { env } from '../config/env.js';
import { logger } from '../util/logger.js';
import type { TraceExporter } from './exporter.js';
import { ConsoleSummaryExporter } from './exporters/console.js';
import { JsonFileExporter } from './exporters/json-file.js';
import { LangfuseExporter } from './exporters/langfuse.js';
import type { Trace } from './types.js';

let exporters: TraceExporter[] | undefined;

/**
 * Build the exporter list from config, once. Console summary is always on; JSON
 * files are the always-on inspectable record (skipped under test); Langfuse is
 * opt-in and only added when its keys are present.
 */
function getExporters(): TraceExporter[] {
  if (exporters) return exporters;

  const list: TraceExporter[] = [new ConsoleSummaryExporter()];
  if (env.NODE_ENV !== 'test') list.push(new JsonFileExporter());
  if (env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_SECRET_KEY) {
    list.push(
      new LangfuseExporter({
        publicKey: env.LANGFUSE_PUBLIC_KEY,
        secretKey: env.LANGFUSE_SECRET_KEY,
        baseUrl: env.LANGFUSE_BASEURL,
      }),
    );
    logger.info('Langfuse trace exporter enabled');
  }
  exporters = list;
  return list;
}

/** Fan a trace out to the given exporters, isolating each one's failures. */
export async function fanOut(trace: Trace, list: TraceExporter[]): Promise<void> {
  await Promise.all(
    list.map((e) =>
      e.export(trace).catch((err) => logger.warn({ err, exporter: e.name }, 'trace export failed')),
    ),
  );
}

/** Fan a finished trace out to every configured exporter; failures never break a turn. */
export async function emitTrace(trace: Trace): Promise<void> {
  await fanOut(trace, getExporters());
}
