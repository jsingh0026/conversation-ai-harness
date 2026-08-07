import type { Trace } from './types.js';

/**
 * A trace sink. The canonical `Trace` fans out to one or more exporters —
 * adding a backend (Langfuse, OTel, a DB) is a new implementation + one line in
 * the exporter list, never a change to the orchestrator. Exporters must not
 * throw into the turn; emit() isolates failures.
 */
export interface TraceExporter {
  readonly name: string;
  export(trace: Trace): Promise<void>;
}
