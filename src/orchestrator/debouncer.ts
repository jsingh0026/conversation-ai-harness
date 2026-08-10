import type { InboundMessage } from '../crm/types.js';

/** A coalesced burst: the combined message + every idempotency key it covers. */
export interface DebouncedBatch {
  conversationId: string;
  message: InboundMessage;
  /** Idempotency keys of all messages folded into this batch (to mark done). */
  keys: string[];
}

interface Buffer {
  messages: InboundMessage[];
  keys: string[];
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Coalesces a rapid burst of messages in the same conversation into ONE turn.
 * A person firing "hi / hi / hi" (or splitting a thought across bubbles) should
 * get a single reply, not one per bubble. Each message still passes idempotency
 * first (so HighLevel *redeliveries* are dropped upstream); this handles the
 * distinct-but-rapid case idempotency can't.
 *
 * windowMs <= 0 disables buffering — the message flushes immediately (the legacy
 * one-reply-per-message behavior; used in tests for determinism).
 */
export class ConversationDebouncer {
  private readonly buffers = new Map<string, Buffer>();

  constructor(
    private readonly windowMs: number,
    private readonly onFlush: (batch: DebouncedBatch) => void,
  ) {}

  add(message: InboundMessage, key: string): void {
    if (this.windowMs <= 0) {
      this.onFlush({ conversationId: message.conversationId, message, keys: [key] });
      return;
    }
    const conv = message.conversationId;
    const existing = this.buffers.get(conv);
    if (existing) {
      clearTimeout(existing.timer);
      existing.messages.push(message);
      existing.keys.push(key);
      existing.timer = setTimeout(() => this.flush(conv), this.windowMs);
    } else {
      this.buffers.set(conv, {
        messages: [message],
        keys: [key],
        timer: setTimeout(() => this.flush(conv), this.windowMs),
      });
    }
  }

  private flush(conversationId: string): void {
    const buf = this.buffers.get(conversationId);
    if (!buf) return;
    this.buffers.delete(conversationId);
    clearTimeout(buf.timer);
    this.onFlush({
      conversationId,
      message: this.combine(buf.messages),
      keys: buf.keys,
    });
  }

  /** Combine buffered messages: dedupe exact repeats (kills "hi/hi/hi"), keep
   *  order, join distinct lines. Metadata comes from the last message. */
  private combine(messages: InboundMessage[]): InboundMessage {
    const last = messages[messages.length - 1]!;
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const m of messages) {
      const body = m.body.trim();
      if (body && !seen.has(body)) {
        seen.add(body);
        lines.push(body);
      }
    }
    return { ...last, body: lines.join('\n') };
  }

  /** Flush all pending buffers now (shutdown / tests). */
  flushAll(): void {
    for (const conv of [...this.buffers.keys()]) this.flush(conv);
  }
}
