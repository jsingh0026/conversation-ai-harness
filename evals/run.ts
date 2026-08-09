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
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { env } from '../src/config/env.js';
import type { ProviderName } from '../src/llm/types.js';
import { ALL_PROVIDERS, createProvider, hasApiKey } from '../src/providers/registry.js';
import { createEmbedder } from '../src/rag/embedder.js';
import { INDEX_PATH, Retriever } from '../src/rag/retriever.js';
import type { KbIndex } from '../src/rag/types.js';
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
  const isProvider = (a: string): a is ProviderName =>
    (ALL_PROVIDERS as readonly string[]).includes(a);
  const isSuite = (a: string): a is Suite => (ALL_SUITES as readonly string[]).includes(a);

  const unknown = argv.filter((a) => !isProvider(a) && !isSuite(a));
  if (unknown.length) {
    console.error(
      `Unknown argument(s): ${unknown.join(', ')}\n` +
        `Providers: ${ALL_PROVIDERS.join(', ')}\nSuites: ${ALL_SUITES.join(', ')}`,
    );
    process.exit(1);
  }

  const providers = argv.filter(isProvider);
  const suites = argv.filter(isSuite);
  return {
    providers: providers.length ? providers : [...ALL_PROVIDERS],
    suites: suites.length ? suites : [...ALL_SUITES],
  };
}

/** Whether embeddings can run: local needs no key; cloud needs its provider key. */
function embedKeyPresent(): boolean {
  if (env.EMBED_LOCAL) return true;
  return env.EMBED_PROVIDER === 'openai'
    ? Boolean(env.OPENAI_API_KEY)
    : Boolean(env.GOOGLE_GENERATIVE_AI_API_KEY);
}

async function main(): Promise<void> {
  const { providers, suites } = parseArgs(process.argv.slice(2));

  const needsRag = suites.includes('rag-trigger') || suites.includes('groundedness');
  if (needsRag) {
    if (!existsSync(INDEX_PATH)) {
      console.error(`No KB index at ${INDEX_PATH}. Run \`pnpm ingest\` first.`);
      process.exit(1);
    }
    if (!embedKeyPresent()) {
      console.error(
        `RAG suites need an embedding key for ${env.EMBED_PROVIDER} (query embeddings). ` +
          `Set it in .env, or run only non-RAG suites (e.g. \`pnpm eval handover latency\`).`,
      );
      process.exit(1);
    }
    // The index must have been built with the same embed model we'll query with.
    const activeModel = env.EMBED_LOCAL ? env.EMBED_LOCAL_MODEL : env.EMBED_MODEL;
    const idx = JSON.parse(readFileSync(INDEX_PATH, 'utf8')) as KbIndex;
    if (idx.embedModel !== activeModel) {
      console.error(
        `KB index was built with ${idx.embedModel} but the active embed model is ${activeModel}. ` +
          `Re-run \`pnpm ingest\`.`,
      );
      process.exit(1);
    }
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

  // Any failure OR any infra error fails the run (a broken provider isn't "green").
  const failed = results.reduce((n, r) => n + r.failures.length + r.errors, 0);
  process.exitCode = failed > 0 ? 1 : 0;
}

void main().catch(async (err) => {
  console.error('Eval run failed:', err instanceof Error ? err.message : err);
  await shutdownTracing();
  process.exit(1);
});
