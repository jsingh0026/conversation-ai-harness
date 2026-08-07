/**
 * Inspect execution traces from the terminal.
 *
 *   pnpm trace                 # list recent turns
 *   pnpm trace <turnId>        # full timeline for one turn
 *   pnpm trace latest          # the most recent turn
 *
 * Reads the JSON traces written by the json-file exporter.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { TRACE_DIR } from './exporters/json-file.js';
import type { ProviderStep, RetrievalStep, ToolStep, Trace } from './types.js';

const isTTY = process.stdout.isTTY;
const c = (code: number, s: string): string => (isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s: string) => c(1, s);
const dim = (s: string) => c(2, s);
const cyan = (s: string) => c(36, s);
const green = (s: string) => c(32, s);
const yellow = (s: string) => c(33, s);
const red = (s: string) => c(31, s);

async function listTraceFiles(): Promise<{ id: string; mtime: number }[]> {
  let files: string[];
  try {
    files = (await readdir(TRACE_DIR)).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const withTime = await Promise.all(
    files.map(async (f) => ({
      id: f.replace(/\.json$/, ''),
      mtime: (await stat(join(TRACE_DIR, f))).mtimeMs,
    })),
  );
  return withTime.sort((a, b) => b.mtime - a.mtime);
}

async function loadTrace(id: string): Promise<Trace> {
  return JSON.parse(await readFile(join(TRACE_DIR, `${id}.json`), 'utf8')) as Trace;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

async function printList(): Promise<void> {
  const files = await listTraceFiles();
  if (files.length === 0) {
    console.log(dim(`No traces in ${TRACE_DIR}. Run the agent to produce some.`));
    return;
  }
  console.log(bold(`\nRecent turns (${files.length}):\n`));
  for (const { id } of files.slice(0, 25)) {
    // Isolate per-file failures (a truncated mid-write file, corrupt JSON, or a
    // race delete) so one bad trace can't break the whole listing.
    try {
      const t = await loadTrace(id);
      const reply = t.reply ? truncate(t.reply.replace(/\s+/g, ' '), 60) : dim('(no reply)');
      console.log(
        `  ${cyan(id)}  ${decisionColor(t.decision)}  ${dim(`${t.latencyMs ?? 0}ms`)}  ${reply}`,
      );
    } catch {
      console.log(`  ${dim(id)}  ${red('(unreadable)')}`);
    }
  }
  console.log(dim('\nRun `pnpm trace <turnId>` for the full timeline.\n'));
}

function decisionColor(decision: string | undefined): string {
  if (!decision) return dim('?');
  if (decision === 'error') return red(decision);
  if (decision === 'handover') return yellow(decision);
  if (decision.startsWith('skill:') || decision === 'knowledge') return green(decision);
  return decision;
}

function printProviderStep(i: number, s: ProviderStep): void {
  const calls = s.toolCalls.map((tc) => `${tc.name}(${truncate(JSON.stringify(tc.args), 60)})`);
  console.log(
    `  ${bold(`${i}.`)} ⚙ ${cyan(`llm:${s.provider}`)} ${dim(`(${s.model})`)}  ${s.latencyMs}ms  ` +
      dim(`in/out ${s.usage.inputTokens}/${s.usage.outputTokens}  finish=${s.finishReason}`),
  );
  if (calls.length) console.log(`       ${dim('tool calls:')} ${calls.join(', ')}`);
  if (s.text) console.log(`       ${dim('text:')} ${truncate(s.text.replace(/\s+/g, ' '), 100)}`);
}

function printRetrievalStep(i: number, s: RetrievalStep): void {
  const g = s.grounded ? green('grounded') : red('no-answer');
  console.log(`  ${bold(`${i}.`)} 🔎 ${cyan('retrieval')} "${truncate(s.query, 50)}"  ${s.latencyMs}ms  ${g}`);
  for (const ch of s.chunks) {
    console.log(`       ${dim('•')} ${ch.docId}  ${yellow(`score ${ch.score.toFixed(3)}`)}`);
    console.log(`         ${dim(truncate(ch.text.replace(/\s+/g, ' '), 90))}`);
  }
}

function printToolStep(i: number, s: ToolStep): void {
  const ok = s.ok ? green('ok') : red('failed');
  console.log(`  ${bold(`${i}.`)} 🛠 ${cyan(`tool:${s.name}`)}  ${s.latencyMs}ms  ${ok}`);
  console.log(`       ${dim('in:')}  ${truncate(JSON.stringify(s.input), 100)}`);
  console.log(`       ${dim('out:')} ${truncate(JSON.stringify(s.output), 100)}`);
}

async function printTrace(id: string): Promise<void> {
  let t: Trace;
  try {
    t = await loadTrace(id);
  } catch {
    console.error(red(`Trace not found: ${id}`));
    process.exitCode = 1;
    return;
  }

  const tok = t.tokens ?? { inputTokens: 0, outputTokens: 0 };
  console.log('\n' + bold('━'.repeat(64)));
  console.log(`${bold(t.turnId)}   ${decisionColor(t.decision)}`);
  console.log(
    dim(
      `latency ${t.latencyMs ?? 0}ms   tokens ${tok.inputTokens + tok.outputTokens} ` +
        `(in ${tok.inputTokens} / out ${tok.outputTokens})   ${t.startedAt}`,
    ),
  );
  console.log(dim(`conversation ${t.conversationId}   contact ${t.contactId}`));
  if (t.budgetExhausted) console.log(yellow('⚠ step budget exhausted'));
  if (t.error) console.log(red(`✗ error: ${t.error}`));

  console.log('\n' + bold('CUSTOMER: ') + t.input);
  console.log('\n' + bold('SYSTEM PROMPT:'));
  console.log(dim(truncate(t.system ?? '', 600)));

  console.log('\n' + bold('STEPS:'));
  (t.steps ?? []).forEach((s, idx) => {
    const i = idx + 1;
    if (s.type === 'provider_call') printProviderStep(i, s);
    else if (s.type === 'retrieval') printRetrievalStep(i, s);
    else printToolStep(i, s);
  });

  console.log('\n' + bold('REPLY: ') + (t.reply ?? dim('(none sent)')));
  console.log(bold('━'.repeat(64)) + '\n');
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg) return printList();
  if (arg === 'latest') {
    const [latest] = await listTraceFiles();
    if (!latest) return printList();
    return printTrace(latest.id);
  }
  return printTrace(arg);
}

void main().catch((err) => {
  console.error(red(err instanceof Error ? err.message : String(err)));
  process.exitCode = 1;
});
