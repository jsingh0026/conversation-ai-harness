import type { LlmMessage } from '../llm/types.js';

/**
 * Per-conversation message history the harness owns. Backs context assembly for
 * the turn loop. In-memory for now; Phase 7 can hydrate from the CRM
 * Conversations API. Only user/assistant text is retained — intra-turn tool
 * scaffolding stays within its turn.
 */
export class ConversationStore {
  private readonly convos = new Map<string, LlmMessage[]>();

  constructor(private readonly maxMessages = 40) {}

  get(conversationId: string): LlmMessage[] {
    return this.convos.get(conversationId) ?? [];
  }

  append(conversationId: string, ...messages: LlmMessage[]): void {
    const existing = this.convos.get(conversationId) ?? [];
    const next = [...existing, ...messages];
    // Keep the tail so context stays bounded.
    this.convos.set(conversationId, next.slice(-this.maxMessages));
  }

  clear(conversationId: string): void {
    this.convos.delete(conversationId);
  }
}
