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
  from: z.string().datetime().optional().describe('ISO start of an explicit range.'),
  to: z.string().datetime().optional().describe('ISO end of an explicit range.'),
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
  startTime: z.string().datetime().describe('ISO start time of the slot the customer chose.'),
  endTime: z.string().datetime().optional().describe('ISO end time (defaults to +30 min).'),
  title: z.string().optional().describe('Short title, e.g. "Property viewing".'),
});

function createBookAppointmentSkill(config: AppointmentConfig): AgentTool {
  const calendarId = config.calendarId ?? env.HL_CALENDAR_ID;

  return {
    spec: {
      name: 'book_appointment',
      description:
        'Book an appointment for a specific slot the customer confirmed. Call only after they ' +
        'pick a time from get_available_slots. If the slot was just taken, offer alternatives.',
      parameters: BookParams,
    },
    run: async (args, ctx) => {
      if (!calendarId) return noCalendar();
      const { startTime, endTime, title } = BookParams.parse(args);

      // Idempotent booking: if this contact already has an appointment at this
      // exact slot, return it instead of creating a duplicate. Guards against a
      // re-driven turn (lease reclaim) or the model calling book twice.
      const target = Date.parse(startTime);
      const existing = (await ctx.crm.getContactAppointments(ctx.contactId)).find(
        (a) => Date.parse(a.startTime) === target,
      );
      if (existing) {
        return {
          booked: true,
          alreadyBooked: true,
          appointment: { id: existing.id, startTime: existing.startTime, endTime: existing.endTime },
        };
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

/** Both appointment tools. */
export function createAppointmentSkills(config: AppointmentConfig = {}): AgentTool[] {
  return [createGetSlotsSkill(config), createBookAppointmentSkill(config)];
}
