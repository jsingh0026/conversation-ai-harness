/**
 * CRM abstraction. The orchestrator and skills only ever see this interface;
 * `MockCrmClient` backs local dev + evals, `HighLevelClient` (Phase 7) talks to
 * the real sandbox. Swapping them is a config change (CRM_MODE), not a code one.
 */

export interface Contact {
  id: string;
  name?: string;
  email?: string;
  phone?: string;
  tags: string[];
  /** Custom + standard fields the Update-Contact-Field skill writes. */
  fields: Record<string, string | number>;
  assignedUserId?: string;
}

/** A prior conversation message, for rehydrating context (CRM-neutral shape). */
export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  /** ISO timestamp — used to keep only recent context on rehydrate. */
  timestamp: string;
}

export interface InboundMessage {
  /** Provider message id — used for idempotency. */
  messageId: string;
  conversationId: string;
  contactId: string;
  body: string;
  /** Channel the customer used; replies go back on the same one. */
  channel: 'SMS' | 'Email' | 'WhatsApp' | 'Live_Chat' | string;
  timestamp: string;
}

export interface SendMessageInput {
  conversationId: string;
  contactId: string;
  channel: string;
  body: string;
}

export interface CalendarSlot {
  /** ISO start/end of an open slot. */
  startTime: string;
  endTime: string;
}

export interface CreateAppointmentInput {
  calendarId: string;
  contactId: string;
  startTime: string;
  endTime: string;
  title?: string;
}

export interface Appointment {
  id: string;
  calendarId: string;
  contactId: string;
  startTime: string;
  endTime: string;
  title?: string;
  status: 'booked' | 'cancelled';
}

/** Whether the bot is still driving a given conversation (handover turns it off). */
export interface BotState {
  conversationId: string;
  enabled: boolean;
}

export interface CrmClient {
  readonly kind: 'mock' | 'highlevel';

  // Conversations
  sendMessage(input: SendMessageInput): Promise<{ messageId: string }>;
  /** Recent messages in a conversation (oldest→newest) for rehydrating context
   *  after a restart. Returns [] if unavailable. */
  getConversationHistory(
    conversationId: string,
    opts?: { limit?: number },
  ): Promise<ConversationMessage[]>;

  // Contacts
  getContact(contactId: string): Promise<Contact>;
  updateContactFields(contactId: string, fields: Record<string, string | number>): Promise<Contact>;
  addTag(contactId: string, tag: string): Promise<void>;
  assignOwner(contactId: string, userId: string): Promise<void>;

  // Calendars
  getFreeSlots(calendarId: string, fromISO: string, toISO: string): Promise<CalendarSlot[]>;
  createAppointment(input: CreateAppointmentInput): Promise<Appointment>;
  /** A contact's booked appointments — used to make booking idempotent. */
  getContactAppointments(contactId: string): Promise<Appointment[]>;
  /** Cancel an appointment (used for reschedule: cancel the old, book the new). */
  cancelAppointment(appointmentId: string): Promise<void>;

  // Bot on/off (handover). Not a native HighLevel concept — the harness owns it,
  // mirrored into the CRM via a tag/owner change by the handover skill.
  isBotEnabled(conversationId: string): Promise<boolean>;
  setBotEnabled(conversationId: string, enabled: boolean): Promise<void>;
}
