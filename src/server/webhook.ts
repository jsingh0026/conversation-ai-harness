import type { InboundMessage } from '../crm/types.js';

/**
 * HighLevel inbound-message webhook payloads are loosely typed and vary by
 * channel. We normalize the fields we care about and tolerate the rest.
 * Kept permissive on purpose — Phase 7 tightens this against real payloads.
 */
export interface HighLevelInboundWebhook {
  type?: string;
  locationId?: string;
  messageId?: string;
  id?: string;
  conversationId?: string;
  contactId?: string;
  body?: string;
  message?: string;
  messageType?: string;
  dateAdded?: string;
  [key: string]: unknown;
}

export interface NormalizedWebhook {
  /** Stable key for idempotency across duplicate deliveries. */
  idempotencyKey: string;
  message: InboundMessage;
}

/**
 * Map a raw webhook body to our canonical InboundMessage, or return a reason
 * string when the payload isn't an inbound customer message we should act on.
 */
export function normalizeWebhook(
  raw: HighLevelInboundWebhook,
): NormalizedWebhook | { skip: string } {
  const messageId = raw.messageId ?? raw.id;
  const conversationId = raw.conversationId;
  const contactId = raw.contactId;
  const body = (raw.body ?? raw.message ?? '').trim();

  if (!messageId) return { skip: 'missing messageId' };
  if (!conversationId) return { skip: 'missing conversationId' };
  if (!contactId) return { skip: 'missing contactId' };
  if (!body) return { skip: 'empty body' };

  return {
    idempotencyKey: messageId,
    message: {
      messageId,
      conversationId,
      contactId,
      body,
      channel: raw.messageType ?? 'SMS',
      timestamp: raw.dateAdded ?? new Date().toISOString(),
    },
  };
}
