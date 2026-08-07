import type { CalendarSlot, Contact } from '../types.js';

/** Shape of a HighLevel contact (the fields we use). */
export interface HlContact {
  id: string;
  firstName?: string;
  lastName?: string;
  contactName?: string;
  name?: string;
  email?: string;
  phone?: string;
  tags?: string[];
  assignedTo?: string;
  customFields?: { id: string; value?: string | number }[];
}

export function mapContact(c: HlContact): Contact {
  const name =
    c.contactName ?? c.name ?? ([c.firstName, c.lastName].filter(Boolean).join(' ') || undefined);
  const fields: Record<string, string | number> = {};
  for (const cf of c.customFields ?? []) {
    if (cf.value !== undefined) fields[cf.id] = cf.value;
  }
  return {
    id: c.id,
    name,
    email: c.email,
    phone: c.phone,
    tags: c.tags ?? [],
    fields,
    assignedUserId: c.assignedTo,
  };
}

/** Our canonical channel → HighLevel Conversations message `type`. */
export function toHlMessageType(channel: string): string {
  switch (channel) {
    case 'SMS':
      return 'SMS';
    case 'Email':
      return 'Email';
    case 'WhatsApp':
      return 'WhatsApp';
    case 'Live_Chat':
      return 'Live_Chat';
    default:
      return 'SMS';
  }
}

/**
 * HighLevel free-slots response is keyed by date, each with a `slots` array of
 * ISO start times (plus a `traceId` we ignore). Flatten to CalendarSlot[],
 * computing an end time from the slot duration (minutes).
 */
export interface HlFreeSlotsResponse {
  [dateOrKey: string]: { slots?: string[] } | string | undefined;
}

export function parseFreeSlots(resp: HlFreeSlotsResponse, durationMin = 30): CalendarSlot[] {
  const out: CalendarSlot[] = [];
  for (const [key, value] of Object.entries(resp)) {
    if (key === 'traceId' || typeof value !== 'object' || value === null) continue;
    for (const start of value.slots ?? []) {
      const startMs = Date.parse(start);
      if (Number.isNaN(startMs)) continue;
      out.push({
        startTime: new Date(startMs).toISOString(),
        endTime: new Date(startMs + durationMin * 60_000).toISOString(),
      });
    }
  }
  return out.sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
}
