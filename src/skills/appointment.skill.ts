import { z } from 'zod';
import { env } from '../config/env.js';
import { SlotTakenError } from '../crm/errors.js';
import type { AgentTool } from '../orchestrator/agent-tool.js';
import { resolveDateRange } from './dates.js';

const DEFAULT_WINDOW_DAYS = 7;
const DEFAULT_DURATION_MIN = 30;
const MAX_OFFERED = 5;

export interface AppointmentConfig {
  calendarId?: string;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
}

const addMinutes = (iso: string, min: number): string =>
  new Date(new Date(iso).getTime() + min * 60_000).toISOString();

function noCalendar(): { error: string } {
  return { error: 'No calendar is configured (set HL_CALENDAR_ID).' };
}

/**
 * get_available_slots — fetch open calendar slots, honoring relative asks like
 * "tomorrow afternoon" or "this week". The model offers the returned slots to
 * the customer; booking is a separate confirming call.
 */
const SlotsParams = z.object({
  when: z
    .string()
    .optional()
    .describe('Natural time range, e.g. "tomorrow afternoon", "this week", "friday morning".'),
  from: z
    .string()
    .datetime({ offset: true, local: true })
    .optional()
    .describe('ISO start of an explicit range.'),
  to: z
    .string()
    .datetime({ offset: true, local: true })
    .optional()
    .describe('ISO end of an explicit range.'),
});

function createGetSlotsSkill(config: AppointmentConfig): AgentTool {
  const calendarId = config.calendarId ?? env.HL_CALENDAR_ID;
  const clock = config.now ?? (() => new Date());

  return {
    spec: {
      name: 'get_available_slots',
      description:
        'Fetch available appointment/viewing times from the calendar. Use before offering ' +
        'times. Accepts a natural range like "tomorrow afternoon" or an explicit ISO from/to.',
      parameters: SlotsParams,
    },
    run: async (args, ctx) => {
      if (!calendarId) return noCalendar();
      const { when, from, to } = SlotsParams.parse(args);
      const now = clock();

      const defaultTo = new Date(now.getTime() + DEFAULT_WINDOW_DAYS * 86_400_000);
      let fromDate: Date;
      let toDate: Date;
      if (from) {
        fromDate = new Date(from);
        toDate = to ? new Date(to) : new Date(fromDate.getTime() + DEFAULT_WINDOW_DAYS * 86_400_000);
        if (toDate <= fromDate) toDate = new Date(fromDate.getTime() + DEFAULT_WINDOW_DAYS * 86_400_000);
      } else if (when) {
        // A null range (unrecognized or wholly-past) falls back to a forward window.
        const range = resolveDateRange(when, now);
        fromDate = range?.from ?? now;
        toDate = range?.to ?? defaultTo;
      } else {
        fromDate = now;
        toDate = defaultTo;
      }

      const raw = await ctx.crm.getFreeSlots(calendarId, fromDate.toISOString(), toDate.toISOString());
      // Defensively keep only slots inside the requested window — don't trust the
      // backend to honor the exact hour range (real calendars may be day-granular).
      const slots = raw.filter((s) => {
        const t = Date.parse(s.startTime);
        return t >= fromDate.getTime() && t <= toDate.getTime();
      });
      if (slots.length === 0) {
        return { available: false, message: 'No open times in that range. Try another day?' };
      }
      return {
        available: true,
        slots: slots.slice(0, MAX_OFFERED).map((s) => ({
          startTime: s.startTime,
          endTime: s.endTime,
          label: new Date(s.startTime).toLocaleString('en-US', {
            weekday: 'short',
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
          }),
        })),
      };
    },
  };
}

/**
 * book_appointment — create the appointment for a specific chosen slot. Handles
 * the slot-taken race (someone booked it between offer and confirm) gracefully.
 */
const BookParams = z.object({
  startTime: z
    .string()
    .datetime({ offset: true, local: true })
    .describe('ISO start time of the slot the customer EXPLICITLY chose.'),
  endTime: z
    .string()
    .datetime({ offset: true, local: true })
    .optional()
    .describe('ISO end time (defaults to +30 min).'),
  title: z.string().optional().describe('Short title, e.g. "Property viewing".'),
  reschedule: z
    .boolean()
    .optional()
    .describe(
      'Set true to MOVE an existing appointment to this new time (cancels the old one). ' +
        'Use when the customer wants to change/reschedule rather than add a second booking.',
    ),
});

function createBookAppointmentSkill(config: AppointmentConfig): AgentTool {
  const calendarId = config.calendarId ?? env.HL_CALENDAR_ID;
  const clock = config.now ?? (() => new Date());

  return {
    spec: {
      name: 'book_appointment',
      description:
        'Book an appointment for a specific time the customer EXPLICITLY chose. First call ' +
        'get_available_slots and present the options; only call this once the customer picks a ' +
        'specific time. NEVER auto-book a slot they did not choose. We must have the customer\'s ' +
        'name and a contact (email or phone) to book — if missing, the tool returns needContactInfo ' +
        'and you should ask for and save those first. If the customer already has an appointment and ' +
        'wants a different time, set reschedule=true to move it. If the slot was just taken, offer alternatives.',
      parameters: BookParams,
    },
    run: async (args, ctx) => {
      if (!calendarId) return noCalendar();
      const { startTime, endTime, title, reschedule } = BookParams.parse(args);

      // Don't book a viewing for someone we can't identify or reach. Require the
      // customer's name and a contact channel first (so the team can confirm the
      // viewing and send reminders). Mirrors the handover gate: return
      // needContactInfo so the model asks for only what's missing, then books.
      const contact = await ctx.crm.getContact(ctx.contactId).catch(() => undefined);
      const hasName = Boolean(contact?.name?.trim());
      const hasReach = Boolean(contact?.email || contact?.phone);
      if (!hasName || !hasReach) {
        const missing = [!hasName ? 'their name' : '', !hasReach ? 'an email or phone number' : '']
          .filter(Boolean)
          .join(' and ');
        return {
          booked: false,
          needContactInfo: true,
          missing,
          instruction:
            `Before booking, ask the customer for ${missing} and save it with ` +
            `update_contact_field, so we can confirm the viewing and send reminders. ` +
            `Do NOT tell them it's booked yet.`,
        };
      }

      const target = Date.parse(startTime);
      const appointments = await ctx.crm.getContactAppointments(ctx.contactId);

      // Idempotent booking: if this contact already has an appointment at this
      // exact slot, return it instead of creating a duplicate. Guards against a
      // re-driven turn (lease reclaim) or the model calling book twice.
      const existing = appointments.find((a) => Date.parse(a.startTime) === target);
      if (existing) {
        return {
          booked: true,
          alreadyBooked: true,
          appointment: { id: existing.id, startTime: existing.startTime, endTime: existing.endTime },
        };
      }

      // Don't silently double-book. If the contact already has an upcoming
      // appointment at a DIFFERENT time, either reschedule (cancel the old, per
      // the flag) or ask the model to confirm intent before creating a second.
      const now = clock().getTime();
      const otherUpcoming = appointments.filter(
        (a) => Date.parse(a.startTime) > now && Date.parse(a.startTime) !== target,
      );
      if (otherUpcoming.length > 0) {
        if (!reschedule) {
          const ex = otherUpcoming[0]!;
          return {
            booked: false,
            needsReschedule: true,
            existing: { id: ex.id, startTime: ex.startTime, endTime: ex.endTime },
            message:
              `The customer already has an appointment at ${ex.startTime}. If they want to MOVE ` +
              `it to the new time, call book_appointment again with reschedule=true. If they want ` +
              `to KEEP both, confirm that with them first.`,
          };
        }
        // Reschedule: cancel the existing upcoming appointment(s) first.
        for (const a of otherUpcoming) {
          await ctx.crm.cancelAppointment(a.id).catch(() => {});
        }
      }

      try {
        const appt = await ctx.crm.createAppointment({
          calendarId,
          contactId: ctx.contactId,
          startTime,
          endTime: endTime ?? addMinutes(startTime, DEFAULT_DURATION_MIN),
          title: title ?? 'Property viewing',
        });
        return {
          booked: true,
          appointment: { id: appt.id, startTime: appt.startTime, endTime: appt.endTime },
        };
      } catch (err) {
        if (err instanceof SlotTakenError) {
          return {
            booked: false,
            reason: 'slot_taken',
            message: 'That time was just taken. Would you like me to pull up other options?',
          };
        }
        throw err; // unexpected → orchestrator records an error tool step
      }
    },
  };
}

/**
 * cancel_appointment — cancel the customer's upcoming appointment (e.g. they ask
 * to cancel, or as the first half of a reschedule). Resolves the appointment id
 * from the contact's bookings, so the model doesn't need to know it.
 */
const CancelParams = z.object({
  startTime: z
    .string()
    .datetime({ offset: true, local: true })
    .optional()
    .describe('ISO start time of the appointment to cancel; omit to cancel the soonest upcoming one.'),
});

function createCancelAppointmentSkill(config: AppointmentConfig): AgentTool {
  const clock = config.now ?? (() => new Date());
  return {
    spec: {
      name: 'cancel_appointment',
      description:
        "Cancel the customer's upcoming appointment. Call when they ask to cancel. Optionally pass " +
        'the startTime to choose which one; otherwise the soonest upcoming appointment is cancelled.',
      parameters: CancelParams,
    },
    run: async (args, ctx) => {
      const { startTime } = CancelParams.parse(args);
      const now = clock().getTime();
      const upcoming = (await ctx.crm.getContactAppointments(ctx.contactId))
        .filter((a) => a.status === 'booked' && Date.parse(a.startTime) > now)
        .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
      if (upcoming.length === 0) {
        return { cancelled: false, message: 'No upcoming appointment to cancel.' };
      }
      const targetAppt = startTime
        ? upcoming.find((a) => Date.parse(a.startTime) === Date.parse(startTime))
        : upcoming[0];
      if (!targetAppt) {
        return { cancelled: false, message: 'No appointment found at that time.' };
      }
      await ctx.crm.cancelAppointment(targetAppt.id);
      return {
        cancelled: true,
        appointment: { id: targetAppt.id, startTime: targetAppt.startTime },
      };
    },
  };
}

/**
 * get_my_appointments — READ-ONLY list of the customer's upcoming appointments.
 * Lets the model answer "do I have an appointment?" / "did it double-book?"
 * without calling booking/cancel tools to find out.
 */
function createListAppointmentsSkill(config: AppointmentConfig): AgentTool {
  const clock = config.now ?? (() => new Date());
  return {
    spec: {
      name: 'get_my_appointments',
      description:
        "List the customer's upcoming appointments (read-only). Use to answer questions about " +
        'what they have booked — do NOT call booking or cancel tools just to check.',
      parameters: z.object({}),
    },
    run: async (_args, ctx) => {
      const now = clock().getTime();
      const upcoming = (await ctx.crm.getContactAppointments(ctx.contactId))
        .filter((a) => a.status === 'booked' && Date.parse(a.startTime) > now)
        .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime))
        .map((a) => ({ id: a.id, startTime: a.startTime, endTime: a.endTime, title: a.title }));
      return { count: upcoming.length, appointments: upcoming };
    },
  };
}

/** All appointment tools: list (read-only), fetch slots, book (with reschedule), cancel. */
export function createAppointmentSkills(config: AppointmentConfig = {}): AgentTool[] {
  return [
    createGetSlotsSkill(config),
    createBookAppointmentSkill(config),
    createCancelAppointmentSkill(config),
    createListAppointmentsSkill(config),
  ];
}
