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
      if (Number.isNaN(Date.parse(start))) continue;
      // Keep the slot's original wall-clock + offset so the agent can quote the
      // office-local time. HighLevel only returns starts; derive the end.
      out.push({ startTime: start, endTime: shiftIso(start, durationMin) });
    }
  }
  return out.sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
}

/** Add minutes to an ISO time while preserving its original UTC offset suffix. */
export function shiftIso(iso: string, minutes: number): string {
  const m = /([zZ]|[+-]\d{2}:\d{2})$/.exec(iso);
  const offset = m ? m[1]! : 'Z';
  const ms = Date.parse(iso) + minutes * 60_000;
  if (offset.toUpperCase() === 'Z') return new Date(ms).toISOString();

  const sign = offset[0] === '-' ? -1 : 1;
  const offMin = sign * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6)));
  const local = new Date(ms + offMin * 60_000);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
    `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}${offset}`
  );
}
