/**
 * One-command eval suite.
 *
 *   pnpm ingest            # build the KB index first (needs an embedding key)
 *   pnpm eval              # every provider with an API key, all suites
 *   pnpm eval openai       # a single provider
 *   pnpm eval claude latency   # provider(s) + suite filter
 *
 * Runs real turns against each provider and reports per-provider results plus a
 * candid failure list. Providers without an API key are skipped.
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderName } from '../src/llm/types.js';
import { ALL_PROVIDERS, createProvider, hasApiKey } from '../src/providers/registry.js';
import { createEmbedder } from '../src/rag/embedder.js';
import { INDEX_PATH, Retriever } from '../src/rag/retriever.js';
import { shutdownTracing } from '../src/trace/emit.js';
import { renderReport } from './report.js';
import {
  runGroundedness,
  runLatency,
  runRagTrigger,
  runSkill,
  type GroundCase,
  type RagCase,
  type SkillCase,
} from './runners.js';
import type { SuiteResult } from './types.js';

const CASES_DIR = join(process.cwd(), 'evals', 'cases');
const loadCases = async <T>(file: string): Promise<T[]> =>
  JSON.parse(await readFile(join(CASES_DIR, file), 'utf8')) as T[];

const ALL_SUITES = [
  'rag-trigger',
  'groundedness',
  'update-contact',
  'handover',
  'appointment',
  'latency',
] as const;
type Suite = (typeof ALL_SUITES)[number];

function parseArgs(argv: string[]): { providers: ProviderName[]; suites: Suite[] } {
  const providers = argv.filter((a): a is ProviderName =>
    (ALL_PROVIDERS as readonly string[]).includes(a),
  );
  const suites = argv.filter((a): a is Suite => (ALL_SUITES as readonly string[]).includes(a));
  return {
    providers: providers.length ? providers : [...ALL_PROVIDERS],
    suites: suites.length ? suites : [...ALL_SUITES],
  };
}

async function main(): Promise<void> {
  const { providers, suites } = parseArgs(process.argv.slice(2));

  if (!existsSync(INDEX_PATH)) {
    console.error(`No KB index at ${INDEX_PATH}. Run \`pnpm ingest\` first.`);
    process.exit(1);
  }

  const active = providers.filter((p) => {
    if (hasApiKey(p)) return true;
    console.log(`(skipping ${p}: no API key)`);
    return false;
  });
  if (active.length === 0) {
    console.error('No providers with API keys configured. Set keys in .env.');
    process.exit(1);
  }

  const [rag, ground, updateContact, handover, appointment] = await Promise.all([
    loadCases<RagCase>('rag-trigger.json'),
    loadCases<GroundCase>('groundedness.json'),
    loadCases<SkillCase>('skill-update-contact.json'),
    loadCases<SkillCase>('skill-handover.json'),
    loadCases<SkillCase>('skill-appointment.json'),
  ]);

  const results: SuiteResult[] = [];
  for (const name of active) {
    const provider = createProvider(name);
    // One retriever per provider run; shares the on-disk index.
    const retriever = new Retriever(createEmbedder());
    console.log(`\n▶ ${name} (${provider.model}) — running ${suites.join(', ')}…`);

    if (suites.includes('rag-trigger')) results.push(await runRagTrigger(provider, retriever, rag));
    if (suites.includes('groundedness'))
      results.push(await runGroundedness(provider, retriever, ground));
    if (suites.includes('update-contact'))
      results.push(
        await runSkill(provider, retriever, updateContact, 'update_contact_field', 'update-contact'),
      );
    if (suites.includes('handover'))
      results.push(
        await runSkill(provider, retriever, handover, 'request_human_handover', 'handover'),
      );
    if (suites.includes('appointment'))
      results.push(
        await runSkill(provider, retriever, appointment, 'get_available_slots', 'appointment'),
      );
    if (suites.includes('latency')) results.push(await runLatency(provider, retriever));
  }

  console.log(renderReport(results));
  await shutdownTracing();

  const failed = results.reduce((n, r) => n + r.failures.length, 0);
  process.exitCode = failed > 0 ? 1 : 0;
}

void main().catch(async (err) => {
  console.error('Eval run failed:', err instanceof Error ? err.message : err);
  await shutdownTracing();
  process.exit(1);
});
