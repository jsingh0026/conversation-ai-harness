import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TraceCollector } from './collector.js';
import { fanOut, selectExporters } from './emit.js';
import type { TraceExporter } from './exporter.js';
import { JsonFileExporter } from './exporters/json-file.js';
import type { Trace } from './types.js';

function sampleTrace(): Trace {
  const t = new TraceCollector({ conversationId: 'c1', contactId: 'ct1', input: 'hi' });
  t.setSystem('sys');
  t.setReply('hello');
  return t.finish();
}

describe('fanOut', () => {
  it('delivers the trace to every exporter', async () => {
    const got: string[] = [];
    const make = (name: string): TraceExporter => ({
      name,
      export: async (tr) => {
        got.push(`${name}:${tr.turnId}`);
      },
    });
    const trace = sampleTrace();
    await fanOut(trace, [make('a'), make('b')]);
    // Assert delivery to both (not order — Promise.all gives no completion order).
    expect(new Set(got)).toEqual(new Set([`a:${trace.turnId}`, `b:${trace.turnId}`]));
  });

  it('isolates a failing exporter so others still run', async () => {
    let ranSecond = false;
    const thrower: TraceExporter = {
      name: 'boom',
      export: async () => {
        throw new Error('nope');
      },
    };
    const ok: TraceExporter = {
      name: 'ok',
      export: async () => {
        ranSecond = true;
      },
    };
    await expect(fanOut(sampleTrace(), [thrower, ok])).resolves.toBeUndefined();
    expect(ranSecond).toBe(true);
  });
});

describe('selectExporters', () => {
  const names = (list: TraceExporter[]) => list.map((e) => e.name);

  it('always includes the console summary, and JSON files outside test', () => {
    expect(names(selectExporters({ isTest: false }))).toEqual(['console', 'json-file']);
  });

  it('omits JSON files under test', () => {
    expect(names(selectExporters({ isTest: true }))).toEqual(['console']);
  });

  it('adds Langfuse only when configured', () => {
    const withLf = selectExporters({
      isTest: false,
      langfuse: { publicKey: 'pk', secretKey: 'sk' },
    });
    expect(names(withLf)).toContain('langfuse');
    expect(names(selectExporters({ isTest: false }))).not.toContain('langfuse');
  });
});

describe('JsonFileExporter', () => {
  it('writes the trace as JSON to disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'traces-'));
    const trace = sampleTrace();
    await new JsonFileExporter(dir).export(trace);
    const written = JSON.parse(await readFile(join(dir, `${trace.turnId}.json`), 'utf8')) as Trace;
    expect(written.turnId).toBe(trace.turnId);
    expect(written.reply).toBe('hello');
  });
});
