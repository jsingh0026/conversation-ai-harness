import { describe, expect, it } from 'vitest';
import { MockCrmClient } from '../crm/mock.js';
import type { CalendarSlot } from '../crm/types.js';
import { makeToolContext } from '../testkit/tool-context.js';
import { createAppointmentSkills } from './appointment.skill.js';

const NOW = new Date(2026, 7, 8, 10, 0, 0); // Sat 2026-08-08 10:00
const CAL = 'cal-1';

// Two slots tomorrow afternoon.
const slots: CalendarSlot[] = [
  { startTime: new Date(2026, 7, 9, 14, 0, 0).toISOString(), endTime: new Date(2026, 7, 9, 14, 30, 0).toISOString() },
  { startTime: new Date(2026, 7, 9, 15, 0, 0).toISOString(), endTime: new Date(2026, 7, 9, 15, 30, 0).toISOString() },
];

function skills(crm: MockCrmClient) {
  const [getSlots, book] = createAppointmentSkills({ calendarId: CAL, now: () => NOW });
  return { getSlots: getSlots!, book: book!, ctx: makeToolContext({ crm }) };
}

describe('appointment skills', () => {
  it('offers slots for a relative "tomorrow afternoon" ask', async () => {
    const crm = new MockCrmClient({ slots: { [CAL]: slots } });
    const { getSlots, ctx } = skills(crm);
    const out = (await getSlots.run({ when: 'tomorrow afternoon' }, ctx)) as {
      available: boolean;
      slots: { startTime: string }[];
    };
    expect(out.available).toBe(true);
    expect(out.slots).toHaveLength(2);
  });

  it('reports no availability gracefully', async () => {
    const crm = new MockCrmClient({ slots: { [CAL]: [] } });
    const { getSlots, ctx } = skills(crm);
    const out = (await getSlots.run({ when: 'tomorrow' }, ctx)) as { available: boolean };
    expect(out.available).toBe(false);
  });

  it('books a chosen slot', async () => {
    const crm = new MockCrmClient({ slots: { [CAL]: slots } });
    const { book, ctx } = skills(crm);
    const out = (await book.run({ startTime: slots[0]!.startTime }, ctx)) as {
      booked: boolean;
      appointment: { id: string };
    };
    expect(out.booked).toBe(true);
    expect(crm.listAppointments()).toHaveLength(1);
  });

  it('handles the slot-taken race gracefully', async () => {
    const crm = new MockCrmClient({ slots: { [CAL]: [] } }); // slot already gone
    const { book, ctx } = skills(crm);
    const out = (await book.run({ startTime: slots[0]!.startTime }, ctx)) as {
      booked: boolean;
      reason?: string;
    };
    expect(out.booked).toBe(false);
    expect(out.reason).toBe('slot_taken');
  });

  it('errors clearly when no calendar is configured', async () => {
    const crm = new MockCrmClient();
    const [getSlots] = createAppointmentSkills({ calendarId: '', now: () => NOW });
    const out = (await getSlots!.run({ when: 'tomorrow' }, makeToolContext({ crm }))) as {
      error?: string;
    };
    expect(out.error).toMatch(/calendar/i);
  });
});
