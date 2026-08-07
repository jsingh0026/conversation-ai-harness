import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TraceExporter } from '../exporter.js';
import type { Trace } from '../types.js';

export const TRACE_DIR = join(process.cwd(), 'traces');

/** Writes one JSON file per turn — the always-on, zero-infra trace record. */
export class JsonFileExporter implements TraceExporter {
  readonly name = 'json-file';

  constructor(private readonly dir = TRACE_DIR) {}

  async export(trace: Trace): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, `${trace.turnId}.json`), JSON.stringify(trace, null, 2));
  }
}
