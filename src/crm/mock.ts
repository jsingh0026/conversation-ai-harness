import { SlotTakenError } from './errors.js';
import type {
  Appointment,
  CalendarSlot,
  Contact,
  ConversationMessage,
  CreateAppointmentInput,
  CrmClient,
  SendMessageInput,
} from './types.js';

let counter = 0;
const nextId = (prefix: string): string => `${prefix}_${(++counter).toString(36)}`;

/** A message the harness sent, captured so tests/evals can assert on replies. */
export interface SentMessage extends SendMessageInput {
  messageId: string;
  sentAt: number;
}

/**
 * In-memory CRM for local dev and evals. Deterministic, no network, and it
 * records every side effect so tests can assert "the reply went out", "the tag
 * was added", "the appointment was booked" without a live sandbox.
 */
export class MockCrmClient implements CrmClient {
  readonly kind = 'mock' as const;

  private contacts = new Map<string, Contact>();
  private botState = new Map<string, boolean>();
  private appointments: Appointment[] = [];
  /** slots keyed by calendarId; a booked slot is removed to model slot-taken races. */
  private slots = new Map<string, CalendarSlot[]>();

  readonly sent: SentMessage[] = [];
  /** Prior conversation history keyed by conversationId (for rehydrate tests). */
  private history = new Map<string, ConversationMessage[]>();

  constructor(seed?: {
    contacts?: Contact[];
    slots?: Record<string, CalendarSlot[]>;
    history?: Record<string, ConversationMessage[]>;
  }) {
    for (const c of seed?.contacts ?? []) this.contacts.set(c.id, c);
    // Copy the seeded slots — booking splices this array, and we must not mutate
    // the caller's fixture (shared across tests).
    for (const [calId, slots] of Object.entries(seed?.slots ?? {})) this.slots.set(calId, [...slots]);
    for (const [cid, msgs] of Object.entries(seed?.history ?? {})) this.history.set(cid, [...msgs]);
  }

  async getConversationHistory(
    conversationId: string,
    opts?: { limit?: number },
  ): Promise<ConversationMessage[]> {
    const all = this.history.get(conversationId) ?? [];
    return opts?.limit ? all.slice(-opts.limit) : all;
  }

  /** Test helper: ensure a contact exists, creating an empty one if needed. */
  upsertContact(contact: Partial<Contact> & { id: string }): Contact {
    const existing = this.contacts.get(contact.id);
    const merged: Contact = {
      id: contact.id,
      name: contact.name ?? existing?.name,
      email: contact.email ?? existing?.email,
      phone: contact.phone ?? existing?.phone,
      tags: contact.tags ?? existing?.tags ?? [],
      fields: { ...existing?.fields, ...contact.fields },
      assignedUserId: contact.assignedUserId ?? existing?.assignedUserId,
    };
    this.contacts.set(merged.id, merged);
    return merged;
  }

  async sendMessage(input: SendMessageInput): Promise<{ messageId: string }> {
    const messageId = nextId('msg');
    this.sent.push({ ...input, messageId, sentAt: Date.now() });
    return { messageId };
  }

  async getContact(contactId: string): Promise<Contact> {
    const c = this.contacts.get(contactId);
    if (!c) throw new Error(`Contact not found: ${contactId}`);
    return structuredClone(c);
  }

  async updateContactFields(
    contactId: string,
    fields: Record<string, string | number>,
  ): Promise<Contact> {
    const c = this.contacts.get(contactId) ?? this.upsertContact({ id: contactId });
    for (const [key, value] of Object.entries(fields)) {
      // Route standard fields to top-level; everything else is a custom field.
      // (HighLevelClient does the equivalent mapping to real field IDs in Phase 7.)
      if (key === 'name') c.name = String(value);
      else if (key === 'email') c.email = String(value);
      else if (key === 'phone') c.phone = String(value);
      else c.fields[key] = value;
    }
    this.contacts.set(contactId, c);
    return structuredClone(c);
  }

  async addTag(contactId: string, tag: string): Promise<void> {
    const c = this.contacts.get(contactId) ?? this.upsertContact({ id: contactId });
    if (!c.tags.includes(tag)) c.tags.push(tag);
  }

  async assignOwner(contactId: string, userId: string): Promise<void> {
    const c = this.contacts.get(contactId) ?? this.upsertContact({ id: contactId });
    c.assignedUserId = userId;
  }

  async getFreeSlots(calendarId: string, fromISO: string, toISO: string): Promise<CalendarSlot[]> {
    const from = Date.parse(fromISO);
    const to = Date.parse(toISO);
    return (this.slots.get(calendarId) ?? []).filter(
      (s) => Date.parse(s.startTime) >= from && Date.parse(s.startTime) <= to,
    );
  }

  async createAppointment(input: CreateAppointmentInput): Promise<Appointment> {
    const open = this.slots.get(input.calendarId) ?? [];
    const idx = open.findIndex((s) => s.startTime === input.startTime);
    if (idx === -1) {
      // Slot no longer available — models the slot-taken race the harness must handle.
      throw new SlotTakenError(input.startTime);
    }
    open.splice(idx, 1);
    const appt: Appointment = {
      id: nextId('appt'),
      calendarId: input.calendarId,
      contactId: input.contactId,
      startTime: input.startTime,
      endTime: input.endTime,
      title: input.title,
      status: 'booked',
    };
    this.appointments.push(appt);
    return appt;
  }

  async getContactAppointments(contactId: string): Promise<Appointment[]> {
    return structuredClone(
      this.appointments.filter((a) => a.contactId === contactId && a.status === 'booked'),
    );
  }

  async cancelAppointment(appointmentId: string): Promise<void> {
    const appt = this.appointments.find((a) => a.id === appointmentId);
    if (appt) {
      appt.status = 'cancelled';
      // Release the slot back so it can be re-offered/re-booked.
      this.slots.get(appt.calendarId)?.push({ startTime: appt.startTime, endTime: appt.endTime });
    }
  }

  async isBotEnabled(conversationId: string): Promise<boolean> {
    return this.botState.get(conversationId) ?? true;
  }

  async setBotEnabled(conversationId: string, enabled: boolean): Promise<void> {
    this.botState.set(conversationId, enabled);
  }

  // --- test introspection ---
  listAppointments(): Appointment[] {
    return structuredClone(this.appointments);
  }
  lastSent(): SentMessage | undefined {
    return this.sent.at(-1);
  }
}

// Re-export so existing imports from './mock.js' keep working.
export { SlotTakenError } from './errors.js';
