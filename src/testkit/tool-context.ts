import { MockCrmClient } from '../crm/mock.js';
import type { ToolContext } from '../orchestrator/agent-tool.js';
import { TraceCollector } from '../trace/collector.js';

/** Build a ToolContext for exercising a skill directly in a test. */
export function makeToolContext(over: Partial<ToolContext> = {}): ToolContext {
  const crm = over.crm ?? new MockCrmClient();
  return {
    conversationId: over.conversationId ?? 'c1',
    contactId: over.contactId ?? 'ct1',
    channel: over.channel ?? 'SMS',
    crm,
    trace:
      over.trace ??
      new TraceCollector({ conversationId: 'c1', contactId: 'ct1', input: 'test' }),
  };
}
