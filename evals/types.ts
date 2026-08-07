/** Result of a single eval case. */
export interface CaseResult {
  id: string;
  pass: boolean;
  detail?: string;
}

/** Aggregated result of one behavior suite for one provider. */
export interface SuiteResult {
  suite: string;
  provider: string;
  total: number;
  passed: number;
  /** Headline metrics (precision/recall/p50/p95/… depending on suite). */
  metrics: Record<string, number>;
  failures: CaseResult[];
  /** Turns that errored (e.g. provider/API failure) rather than mis-answered. */
  errors: number;
}
