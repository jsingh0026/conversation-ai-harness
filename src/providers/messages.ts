import { tool, type ModelMessage, type ToolSet } from 'ai';
import type { LlmMessage, ToolSpec } from '../llm/types.js';

/**
 * Convert our canonical messages to the AI SDK's ModelMessage shape. This is the
 * one place provider-specific message wiring lives — assistant tool-calls and
 * tool-results map to the SDK's part format so the tool-use loop round-trips.
 */
export function toModelMessages(messages: LlmMessage[]): ModelMessage[] {
  return messages.map((m): ModelMessage => {
    switch (m.role) {
      case 'user':
        return { role: 'user', content: m.content };

      case 'assistant': {
        if (!m.toolCalls?.length) return { role: 'assistant', content: m.content };
        const parts: Extract<ModelMessage, { role: 'assistant' }>['content'] = [];
        if (m.content) parts.push({ type: 'text', text: m.content });
        for (const tc of m.toolCalls) {
          parts.push({ type: 'tool-call', toolCallId: tc.id, toolName: tc.name, input: tc.args });
        }
        return { role: 'assistant', content: parts };
      }

      case 'tool':
        return {
          role: 'tool',
          content: m.toolResults.map((tr) => ({
            type: 'tool-result' as const,
            toolCallId: tr.toolCallId,
            toolName: tr.name,
            output: { type: 'json' as const, value: tr.result as never },
          })),
        };
    }
  });
}

/**
 * Build the AI SDK tool set from our specs. Tools are declared WITHOUT an
 * `execute` so the model returns tool calls for the harness to run itself,
 * rather than the SDK auto-executing them.
 */
export function toToolSet(tools: ToolSpec[] | undefined): ToolSet | undefined {
  if (!tools?.length) return undefined;
  const set: ToolSet = {};
  for (const t of tools) {
    set[t.name] = tool({ description: t.description, inputSchema: t.parameters });
  }
  return set;
}
