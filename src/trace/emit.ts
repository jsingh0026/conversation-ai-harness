import { env } from '../config/env.js';
import { logger } from '../util/logger.js';
import { redactTrace } from '../util/redact.js';
import type { TraceExporter } from './exporter.js';
import { ConsoleSummaryExporter } from './exporters/console.js';
import { JsonFileExporter } from './exporters/json-file.js';
import { LangfuseExporter, type LangfuseConfig } from './exporters/langfuse.js';
import type { Trace } from './types.js';

let exporters: TraceExporter[] | undefined;

export interface ExporterOptions {
  isTest: boolean;
  langfuse?: LangfuseConfig;
}

/**
 * Compose the exporter list (pure — takes explicit flags). Console summary is
 * always on; JSON files are on except under test; Langfuse is added only when
 * configured.
 */
export function selectExporters(opts: ExporterOptions): TraceExporter[] {
  const list: TraceExporter[] = [new ConsoleSummaryExporter()];
  if (!opts.isTest) list.push(new JsonFileExporter());
  if (opts.langfuse) list.push(new LangfuseExporter(opts.langfuse));
  return list;
}

/** Build the exporter list from env, once. */
function getExporters(): TraceExporter[] {
  if (exporters) return exporters;
  const langfuse =
    env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_SECRET_KEY
      ? {
          publicKey: env.LANGFUSE_PUBLIC_KEY,
          secretKey: env.LANGFUSE_SECRET_KEY,
          baseUrl: env.LANGFUSE_BASEURL,
        }
      : undefined;
  exporters = selectExporters({ isTest: env.NODE_ENV === 'test', langfuse });
  if (langfuse) logger.info('Langfuse trace exporter enabled');
  return exporters;
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
  // Mask PII once here so every sink (Langfuse, JSON file) receives redacted data.
  await fanOut(redactTrace(trace), getExporters());
}

/** Drain batched exporters (e.g. Langfuse) on process shutdown. */
export async function shutdownTracing(): Promise<void> {
  for (const e of exporters ?? []) {
    if (e.shutdown) await e.shutdown();
  }
}
