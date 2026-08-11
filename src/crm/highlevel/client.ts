import { logger } from '../../util/logger.js';
import { SlotTakenError } from '../errors.js';
import type {
  Appointment,
  CalendarSlot,
  Contact,
  ConversationMessage,
  CreateAppointmentInput,
  CrmClient,
  SendMessageInput,
} from '../types.js';

/** Shape of a HighLevel conversation message (fields we use). */
interface HlConversationMessage {
  id?: string;
  direction?: string; // 'inbound' | 'outbound'
  body?: string;
  dateAdded?: string;
}
import { HlApiError, type HlHttp } from './http.js';
import {
  mapContact,
  parseFreeSlots,
  toHlMessageType,
  type HlContact,
  type HlFreeSlotsResponse,
} from './mappers.js';

export interface HighLevelClientConfig {
  locationId: string;
  /** Custom-field IDs for the fields the update-contact skill writes. */
  fieldMap: { budget?: string; preferredTime?: string };
  /** User the booked appointment is assigned to (HighLevel requires this). */
  assignedUserId?: string;
  slotDurationMin?: number;
  /** Contact tag the handover skill writes; used to rehydrate bot-off state. */
  handoverTag?: string;
}

/** Standard contact fields go top-level; the rest map to custom-field IDs. */
const STANDARD_FIELDS = new Set(['name', 'email', 'phone']);

/** Loose shape of a HighLevel appointment event (fields vary by calendar). */
interface HlAppointmentEvent {
  id?: string;
  calendarId?: string;
  startTime?: string;
  endTime?: string;
  title?: string;
  appointmentStatus?: string;
}

/**
 * Real HighLevel CRM client. Same `CrmClient` interface as the mock, so the
 * orchestrator and skills are unchanged — selection is `CRM_MODE=highlevel`.
 * Bot on/off is process-local (HighLevel has no such concept); it's mirrored
 * into the CRM as a tag by the handover skill for visibility.
 */
export class HighLevelClient implements CrmClient {
  readonly kind = 'highlevel' as const;
  private readonly botState = new Map<string, boolean>();

  constructor(
    private readonly http: HlHttp,
    private readonly config: HighLevelClientConfig,
  ) {}

  async sendMessage(input: SendMessageInput): Promise<{ messageId: string }> {
    const res = await this.http.post<{ messageId?: string; id?: string }>('/conversations/messages', {
      body: { type: toHlMessageType(input.channel), contactId: input.contactId, message: input.body },
    });
    return { messageId: res.messageId ?? res.id ?? '' };
  }

  async getConversationHistory(
    conversationId: string,
    opts?: { limit?: number },
  ): Promise<ConversationMessage[]> {
    // Fail-open: if the fetch errors or the shape differs, return none so a turn
    // still proceeds (just without rehydrated context).
    try {
      const res = await this.http.get<{ messages?: { messages?: HlConversationMessage[] } }>(
        `/conversations/${conversationId}/messages`,
        { query: { limit: opts?.limit ?? 20 } },
      );
      const raw = res.messages?.messages ?? [];
      return raw
        .filter((m) => (m.body ?? '').trim())
        .map((m) => ({
          role: /out/i.test(m.direction ?? '') ? ('assistant' as const) : ('user' as const),
          content: m.body!.trim(),
          timestamp: m.dateAdded ?? '',
        }))
        // HighLevel returns newest-first; we want oldest→newest for context.
        .reverse();
    } catch (err) {
      logger.warn({ err, conversationId }, 'getConversationHistory failed; no rehydrated context');
      return [];
    }
  }

  async getContact(contactId: string): Promise<Contact> {
    const res = await this.http.get<{ contact: HlContact }>(`/contacts/${contactId}`);
    return mapContact(res.contact);
  }

  async updateContactFields(
    contactId: string,
    fields: Record<string, string | number>,
  ): Promise<Contact> {
    const body: Record<string, unknown> = {};
    const customFields: { id: string; value: string | number }[] = [];

    for (const [key, value] of Object.entries(fields)) {
      if (key === 'name') {
        const [first, ...rest] = String(value).split(' ');
        body.firstName = first;
        if (rest.length) body.lastName = rest.join(' ');
      } else if (STANDARD_FIELDS.has(key)) {
        body[key] = value;
      } else {
        const id = this.config.fieldMap[key as keyof HighLevelClientConfig['fieldMap']];
        if (id) customFields.push({ id, value });
        else logger.warn({ key }, 'no custom-field id configured; skipping');
      }
    }
    if (customFields.length) body.customFields = customFields;

    const res = await this.http.put<{ contact: HlContact }>(`/contacts/${contactId}`, { body });
    return mapContact(res.contact);
  }

  async addTag(contactId: string, tag: string): Promise<void> {
    await this.http.post(`/contacts/${contactId}/tags`, { body: { tags: [tag] } });
  }

  async assignOwner(contactId: string, userId: string): Promise<void> {
    await this.http.put(`/contacts/${contactId}`, { body: { assignedTo: userId } });
  }

  async getFreeSlots(calendarId: string, fromISO: string, toISO: string): Promise<CalendarSlot[]> {
    // Uses the default Version (2021-07-28) — the same as every other resource.
    const resp = await this.http.get<HlFreeSlotsResponse>(`/calendars/${calendarId}/free-slots`, {
      query: { startDate: Date.parse(fromISO), endDate: Date.parse(toISO) },
    });
    return parseFreeSlots(resp, this.config.slotDurationMin);
  }

  async createAppointment(input: CreateAppointmentInput): Promise<Appointment> {
    try {
      const res = await this.http.post<{ id?: string; appointmentId?: string }>(
        '/calendars/events/appointments',
        {
          body: {
            calendarId: input.calendarId,
            locationId: this.config.locationId,
            contactId: input.contactId,
            startTime: input.startTime,
            endTime: input.endTime,
            title: input.title ?? 'Property viewing',
            // HighLevel requires an assignee for most calendars.
            assignedUserId: this.config.assignedUserId,
          },
        },
      );
      return {
        id: res.id ?? res.appointmentId ?? '',
        calendarId: input.calendarId,
        contactId: input.contactId,
        startTime: input.startTime,
        endTime: input.endTime,
        title: input.title,
        status: 'booked',
      };
    } catch (err) {
      if (err instanceof HlApiError && isSlotConflict(err)) {
        throw new SlotTakenError(input.startTime);
      }
      throw err;
    }
  }

  async cancelAppointment(appointmentId: string): Promise<void> {
    // HighLevel appointments are calendar events; delete by event id.
    await this.http.delete(`/calendars/events/${appointmentId}`);
  }

  async getContactAppointments(contactId: string): Promise<Appointment[]> {
    // Fail-open: if the lookup errors or the shape differs, return none so
    // booking still proceeds. The idempotency lease is the primary guard; this
    // is a best-effort second layer against duplicate bookings.
    try {
      const res = await this.http.get<{ events?: HlAppointmentEvent[] }>(
        `/contacts/${contactId}/appointments`,
      );
      return (res.events ?? [])
        .filter((e) => e.startTime)
        .map((e) => ({
          id: e.id ?? '',
          calendarId: e.calendarId ?? '',
          contactId,
          startTime: e.startTime!,
          endTime: e.endTime ?? e.startTime!,
          title: e.title,
          status: /cancel/i.test(e.appointmentStatus ?? '') ? 'cancelled' : 'booked',
        }));
    } catch (err) {
      logger.warn({ err, contactId }, 'getContactAppointments failed; proceeding without dedup');
      return [];
    }
  }

  async isBotEnabled(conversationId: string): Promise<boolean> {
    // Fast path: the in-memory flag is authoritative once we've seen this
    // conversation in this process.
    const known = this.botState.get(conversationId);
    if (known !== undefined) return known;

    // Cache miss — either a brand-new conversation or the first turn after a
    // restart. The durable handover marker is a contact tag, so rehydrate from
    // it. In the live flow the workflow sends conversationId === contact.id, so
    // we can read the contact directly. This costs one lookup per conversation
    // (not per turn), and a transient failure defaults to enabled rather than
    // silently muting the bot.
    let enabled = true;
    if (this.config.handoverTag) {
      try {
        const contact = await this.getContact(conversationId);
        if (contact.tags.includes(this.config.handoverTag)) enabled = false;
      } catch (err) {
        logger.warn({ err, conversationId }, 'handover-tag rehydrate failed; assuming bot enabled');
      }
    }
    this.botState.set(conversationId, enabled);
    return enabled;
  }

  async setBotEnabled(conversationId: string, enabled: boolean): Promise<void> {
    this.botState.set(conversationId, enabled);
  }
}

/**
 * A taken slot surfaces as a conflict. We map narrowly: a 409, or a 4xx whose
 * body clearly names slot unavailability. Anything else (e.g. a validation
 * error) rethrows unchanged so it isn't silently mislabeled as a race.
 */
function isSlotConflict(err: HlApiError): boolean {
  if (err.status === 409) return true;
  if (![400, 422].includes(err.status)) return false;
  return /slot (is )?(not available|taken|unavailable)|already booked|time.*not available/i.test(
    err.body,
  );
}
