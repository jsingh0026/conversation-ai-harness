import { z } from 'zod';
import type { AgentTool } from '../orchestrator/agent-tool.js';
import type { Retriever } from './retriever.js';

/**
 * The tool description IS the RAG-trigger policy: it tells the model exactly
 * when to retrieve (factual business questions) and — critically — to answer
 * ONLY from results and to admit when nothing relevant is found. Chit-chat and
 * skill-only turns simply never call it, so those turns never hit the store.
 */
const DESCRIPTION = [
  "Search the business's knowledge base for factual answers about the company:",
  'services, pricing/fees, process, financing, neighborhoods, hours, policies, and FAQs.',
  'Call this whenever the customer asks a factual question about the business',
  '(e.g. "how much is your commission?", "do you handle rentals?", "what areas do you cover?").',
  'Do NOT call it for greetings, small talk, or when running another skill.',
  'Answer ONLY from the returned results. If nothing relevant is returned',
  "(grounded: false), tell the customer you don't have that information rather than guessing.",
].join(' ');

const ParamsSchema = z.object({
  query: z.string().min(1).describe('A focused search query capturing the customer\'s question.'),
});

/** Build the retrieval tool over a Retriever. Adding it to the agent = one line. */
export function createSearchKbTool(retriever: Retriever): AgentTool {
  return {
    spec: { name: 'search_knowledge_base', description: DESCRIPTION, parameters: ParamsSchema },
    // Records its own retrieval step (chunks + scores); no generic tool step.
    selfRecords: true,
    run: async (args, ctx) => {
      const { query } = ParamsSchema.parse(args);
      const t0 = Date.now();
      const result = await retriever.retrieve(query);

      // Record chunks + scores on the trace so a reviewer sees exactly what
      // grounded (or failed to ground) the answer.
      ctx.trace.addRetrievalStep({
        query,
        latencyMs: Date.now() - t0,
        chunks: result.chunks.map((c) => ({ docId: c.docId, score: c.score, text: c.text })),
        grounded: result.grounded,
      });

      if (!result.grounded) {
        return {
          grounded: false,
          message: 'No relevant information found in the knowledge base.',
          results: [],
        };
      }

      return {
        grounded: true,
        results: result.chunks.map((c) => ({
          title: c.title,
          section: c.section,
          snippet: c.text,
          score: Number(c.score.toFixed(3)),
        })),
      };
    },
  };
}
