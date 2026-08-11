import type { LlmMessage } from '../llm/types.js';

/**
 * Per-conversation message history the harness owns, backing context assembly
 * for the turn loop. In-memory; only user/assistant text is retained (intra-turn
 * tool scaffolding stays within its turn).
 *
 * HighLevel keeps ONE conversation per contact for live chat (a visitor's "start
 * new chat" appends to the same thread), and exposes no per-session id — so the
 * only signal for "this is a fresh chat" is time. When the gap since the last
 * message exceeds `idleResetMs`, the prior context is dropped: a refresh or an
 * active back-and-forth keeps context, a next-day return starts clean.
 */
export class ConversationStore {
  private readonly convos = new Map<string, LlmMessage[]>();
  private readonly lastSeen = new Map<string, number>();

  constructor(
    private readonly maxMessages = 40,
    private readonly idleResetMs = 30 * 60 * 1000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * History for the next turn. If the conversation has been idle past the reset
   * window, it's cleared first so stale context doesn't bleed into a new chat.
   */
  get(conversationId: string): LlmMessage[] {
    const last = this.lastSeen.get(conversationId);
    if (last !== undefined && this.now() - last > this.idleResetMs) {
      this.convos.delete(conversationId);
      this.lastSeen.delete(conversationId);
    }
    return this.convos.get(conversationId) ?? [];
  }

  append(conversationId: string, ...messages: LlmMessage[]): void {
    const existing = this.convos.get(conversationId) ?? [];
    const next = [...existing, ...messages];
    // Keep the tail so context stays bounded.
    this.convos.set(conversationId, next.slice(-this.maxMessages));
    this.lastSeen.set(conversationId, this.now());
  }

  clear(conversationId: string): void {
    this.convos.delete(conversationId);
    this.lastSeen.delete(conversationId);
  }

  /**
   * Evict every conversation idle past the reset window. `get()` only resets a
   * conversation lazily when it comes BACK — so a visitor who chats once and
   * never returns would otherwise linger forever, making memory grow with every
   * conversation ever seen rather than the ACTIVE set. A periodic sweep keeps
   * the store bounded. Returns the number of conversations removed.
   */
  sweep(): number {
    const cutoff = this.now() - this.idleResetMs;
    let removed = 0;
    for (const [id, seen] of this.lastSeen) {
      if (seen < cutoff) {
        this.convos.delete(id);
        this.lastSeen.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  /** Number of conversations currently held (for metrics/tests). */
  size(): number {
    return this.convos.size;
  }

  /**
   * Run {@link sweep} on an interval. The timer is `unref`'d so it never keeps
   * the process alive, and `onSweep` (optional) receives the eviction count for
   * logging/metrics. Returns a stop function to clear the interval on shutdown.
   */
  startSweeper(intervalMs = this.idleResetMs, onSweep?: (removed: number) => void): () => void {
    const timer = setInterval(() => {
      const removed = this.sweep();
      if (removed && onSweep) onSweep(removed);
    }, intervalMs);
    (timer as { unref?: () => void }).unref?.();
    return () => clearInterval(timer);
  }
}
