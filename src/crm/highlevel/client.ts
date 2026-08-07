import { logger } from '../../util/logger.js';
import { SlotTakenError } from '../errors.js';
import type {
  Appointment,
  CalendarSlot,
  Contact,
  CreateAppointmentInput,
  CrmClient,
  SendMessageInput,
} from '../types.js';
import { HlApiError, type HlHttp } from './http.js';
import {
  mapContact,
  parseFreeSlots,
  toHlMessageType,
  type HlContact,
  type HlFreeSlotsResponse,
} from './mappers.js';

const CALENDAR_VERSION = '2021-04-15';

export interface HighLevelClientConfig {
  locationId: string;
  /** Custom-field IDs for the fields the update-contact skill writes. */
  fieldMap: { budget?: string; preferredTime?: string };
  slotDurationMin?: number;
}

/** Standard contact fields go top-level; the rest map to custom-field IDs. */
const STANDARD_FIELDS = new Set(['name', 'email', 'phone']);

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
    const resp = await this.http.get<HlFreeSlotsResponse>(`/calendars/${calendarId}/free-slots`, {
      query: { startDate: Date.parse(fromISO), endDate: Date.parse(toISO) },
      version: CALENDAR_VERSION,
    });
    return parseFreeSlots(resp, this.config.slotDurationMin);
  }

  async createAppointment(input: CreateAppointmentInput): Promise<Appointment> {
    try {
      const res = await this.http.post<{ id?: string; appointmentId?: string }>(
        '/calendars/events/appointments',
        {
          version: CALENDAR_VERSION,
          body: {
            calendarId: input.calendarId,
            locationId: this.config.locationId,
            contactId: input.contactId,
            startTime: input.startTime,
            endTime: input.endTime,
            title: input.title,
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

  async isBotEnabled(conversationId: string): Promise<boolean> {
    return this.botState.get(conversationId) ?? true;
  }

  async setBotEnabled(conversationId: string, enabled: boolean): Promise<void> {
    this.botState.set(conversationId, enabled);
  }
}

/** A taken slot surfaces as a 4xx whose body mentions the conflict. */
function isSlotConflict(err: HlApiError): boolean {
  if (![400, 409, 422].includes(err.status)) return false;
  return /slot|not available|unavailable|conflict|already booked/i.test(err.body);
}
