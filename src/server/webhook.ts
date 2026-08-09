import { createHash } from 'node:crypto';
import type { InboundMessage } from '../crm/types.js';

/**
 * HighLevel inbound-message webhook payloads are loosely typed and vary by
 * channel/source. We normalize the fields we care about and tolerate the rest.
 * A HighLevel *workflow* webhook can send the contact id + message body but not
 * a stable message id or conversation id, so we derive those.
 */
export interface HighLevelInboundWebhook {
  type?: string;
  locationId?: string;
  messageId?: string;
  id?: string;
  conversationId?: string;
  contactId?: string;
  contact_id?: string;
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
 * string when the payload isn't an actionable inbound message. Only the
 * contactId and message body are strictly required.
 */
export function normalizeWebhook(
  raw: HighLevelInboundWebhook,
): NormalizedWebhook | { skip: string } {
  const contactId = raw.contactId ?? raw.contact_id;
  const body = (raw.body ?? raw.message ?? '').trim();

  if (!contactId) return { skip: 'missing contactId' };
  if (!body) return { skip: 'empty body' };

  const conversationId = raw.conversationId ?? contactId;
  // Prefer a real id; otherwise synthesize one that still dedupes rapid
  // duplicate deliveries (same contact+body within a short window) while
  // letting a genuine repeat later through.
  const messageId = raw.messageId ?? raw.id ?? synthesizeMessageId(contactId, body);

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

function synthesizeMessageId(contactId: string, body: string): string {
  const bucket = Math.floor(Date.now() / 10_000); // 10-second window
  const hash = createHash('sha1').update(`${contactId}|${body}|${bucket}`).digest('hex');
  return `gen_${hash.slice(0, 16)}`;
}
