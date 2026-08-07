import { describe, expect, it } from 'vitest';
import { MockCrmClient } from '../crm/mock.js';
import type { ToolContext } from '../orchestrator/agent-tool.js';
import { TraceCollector } from '../trace/collector.js';
import { FakeEmbedder } from '../testkit/fake-embedder.js';
import { Retriever } from './retriever.js';
import { createSearchKbTool } from './search-kb.tool.js';
import { VectorStore } from './store.js';
import type { EmbeddedChunk } from './types.js';

async function toolAndCtx() {
  const embedder = new FakeEmbedder();
  const text = 'Our seller commission is five percent of the sale price.';
  const [embedding] = await embedder.embedMany([text]);
  const chunk: EmbeddedChunk = { id: 'fees#0', docId: 'fees', title: 'Fees', text, embedding: embedding! };
  const retriever = new Retriever(embedder);
  retriever.useStore(new VectorStore([chunk]));

  const trace = new TraceCollector({ conversationId: 'c1', contactId: 'ct1', input: 'q' });
  const ctx: ToolContext = {
    conversationId: 'c1',
    contactId: 'ct1',
    channel: 'SMS',
    crm: new MockCrmClient(),
    trace,
  };
  return { tool: createSearchKbTool(retriever), ctx, trace };
}

describe('search_knowledge_base tool', () => {
  it('returns grounded results and records a retrieval step on the trace', async () => {
    const { tool, ctx, trace } = await toolAndCtx();
    const out = (await tool.run({ query: 'seller commission price sale' }, ctx)) as {
      grounded: boolean;
      results: { snippet: string; score: number }[];
    };

    expect(out.grounded).toBe(true);
    expect(out.results[0]?.snippet).toContain('commission');
    const retrieval = trace.finish().steps.find((s) => s.type === 'retrieval');
    expect(retrieval).toMatchObject({ type: 'retrieval', grounded: true });
  });

  it('returns an explicit no-answer for an unrelated query', async () => {
    const { tool, ctx } = await toolAndCtx();
    const out = (await tool.run({ query: 'unrelated zebra astrophysics quantum' }, ctx)) as {
      grounded: boolean;
      message?: string;
    };
    expect(out.grounded).toBe(false);
    expect(out.message).toMatch(/no relevant information/i);
  });

  it('exposes a stable tool name for RAG-trigger evals', () => {
    const embedder = new FakeEmbedder();
    const tool = createSearchKbTool(new Retriever(embedder));
    expect(tool.spec.name).toBe('search_knowledge_base');
  });
});
