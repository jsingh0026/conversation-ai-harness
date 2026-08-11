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

// A contact we can reach — booking requires name + email/phone (see the gate test).
const CONTACT = { id: 'ct1', name: 'Sam Rivera', email: 'sam@example.com' };

function skills(crm: MockCrmClient, seedContact = true) {
  if (seedContact) crm.upsertContact(CONTACT);
  const [getSlots, book, cancel] = createAppointmentSkills({ calendarId: CAL, now: () => NOW });
  return { getSlots: getSlots!, book: book!, cancel: cancel!, ctx: makeToolContext({ crm }) };
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

  it('filters out slots outside the requested part-of-day window', async () => {
    // A morning slot + an afternoon slot; asking for "afternoon" must exclude the morning one.
    const morning = {
      startTime: new Date(2026, 7, 9, 9, 0, 0).toISOString(),
      endTime: new Date(2026, 7, 9, 9, 30, 0).toISOString(),
    };
    const crm = new MockCrmClient({ slots: { [CAL]: [morning, ...slots] } });
    const { getSlots, ctx } = skills(crm);
    const out = (await getSlots.run({ when: 'tomorrow afternoon' }, ctx)) as {
      available: boolean;
      slots: { startTime: string }[];
    };
    expect(out.slots).toHaveLength(2); // only the two afternoon slots
    expect(out.slots.some((s) => s.startTime === morning.startTime)).toBe(false);
  });

  it('reports no availability gracefully', async () => {
    const crm = new MockCrmClient({ slots: { [CAL]: [] } });
    const { getSlots, ctx } = skills(crm);
    const out = (await getSlots.run({ when: 'tomorrow' }, ctx)) as { available: boolean };
    expect(out.available).toBe(false);
  });

  it('requires the customer\'s name + contact before booking', async () => {
    const crm = new MockCrmClient({ slots: { [CAL]: slots } }); // no contact on file
    const { book, ctx } = skills(crm, false); // don't seed the contact
    const out = (await book.run({ startTime: slots[0]!.startTime }, ctx)) as {
      booked: boolean;
      needContactInfo?: boolean;
      missing?: string;
    };
    expect(out.booked).toBe(false);
    expect(out.needContactInfo).toBe(true);
    expect(out.missing).toContain('name');
    expect(crm.listAppointments()).toHaveLength(0); // nothing booked
  });

  it('books once we have name + a contact channel', async () => {
    const crm = new MockCrmClient({ slots: { [CAL]: slots } });
    const { book, ctx } = skills(crm); // seeds a reachable contact
    const out = (await book.run({ startTime: slots[0]!.startTime }, ctx)) as { booked: boolean };
    expect(out.booked).toBe(true);
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

  it('accepts ISO startTimes with a timezone offset or no tz (provider-agnostic)', async () => {
    // Models echo the offset our slots return (+05:30) or emit UTC-offset / bare
    // local times. All are valid ISO 8601 and must be accepted, not rejected.
    for (const startTime of [
      '2026-08-09T14:30:00+05:30',
      '2026-08-09T09:00:00+00:00',
      '2026-08-09T14:30:00', // bare local (no tz)
    ]) {
      const crm = new MockCrmClient({ slots: { [CAL]: slots } });
      const { book, ctx } = skills(crm);
      const out = (await book.run({ startTime }, ctx)) as { error?: string };
      expect(out.error).not.toBe('Invalid arguments'); // schema no longer rejects it
    }
  });

  it('is idempotent: re-booking the same slot returns the existing appointment', async () => {
    const crm = new MockCrmClient({ slots: { [CAL]: slots } });
    const { book, ctx } = skills(crm);
    const first = (await book.run({ startTime: slots[0]!.startTime }, ctx)) as {
      appointment: { id: string };
    };
    const second = (await book.run({ startTime: slots[0]!.startTime }, ctx)) as {
      booked: boolean;
      alreadyBooked?: boolean;
      appointment: { id: string };
    };
    expect(second.booked).toBe(true);
    expect(second.alreadyBooked).toBe(true);
    expect(second.appointment.id).toBe(first.appointment.id);
    expect(crm.listAppointments()).toHaveLength(1); // no duplicate
  });

  it('does NOT double-book: a different time when one exists returns needsReschedule', async () => {
    const crm = new MockCrmClient({ slots: { [CAL]: slots } });
    const { book, ctx } = skills(crm);
    await book.run({ startTime: slots[0]!.startTime }, ctx); // first booking (2 PM)

    const out = (await book.run({ startTime: slots[1]!.startTime }, ctx)) as {
      booked: boolean;
      needsReschedule?: boolean;
      existing?: { startTime: string };
    };
    expect(out.booked).toBe(false);
    expect(out.needsReschedule).toBe(true);
    expect(out.existing?.startTime).toBe(slots[0]!.startTime);
    expect(crm.listAppointments().filter((a) => a.status === 'booked')).toHaveLength(1); // no 2nd
  });

  it('reschedule=true moves the appointment: cancels the old, books the new', async () => {
    const crm = new MockCrmClient({ slots: { [CAL]: slots } });
    const { book, ctx } = skills(crm);
    await book.run({ startTime: slots[0]!.startTime }, ctx); // 2 PM

    const out = (await book.run({ startTime: slots[1]!.startTime, reschedule: true }, ctx)) as {
      booked: boolean;
      appointment: { startTime: string };
    };
    expect(out.booked).toBe(true);
    expect(out.appointment.startTime).toBe(slots[1]!.startTime);
    const active = crm.listAppointments().filter((a) => a.status === 'booked');
    expect(active).toHaveLength(1); // only the new one
    expect(active[0]!.startTime).toBe(slots[1]!.startTime);
  });

  it('cancel_appointment cancels the soonest upcoming booking', async () => {
    const crm = new MockCrmClient({ slots: { [CAL]: slots } });
    const { book, cancel, ctx } = skills(crm);
    await book.run({ startTime: slots[0]!.startTime }, ctx);

    const out = (await cancel.run({}, ctx)) as { cancelled: boolean; appointment?: { startTime: string } };
    expect(out.cancelled).toBe(true);
    expect(out.appointment?.startTime).toBe(slots[0]!.startTime);
    expect(crm.listAppointments().filter((a) => a.status === 'booked')).toHaveLength(0);
  });

  it('cancel_appointment with no upcoming appointment is a no-op', async () => {
    const crm = new MockCrmClient({ slots: { [CAL]: slots } });
    const { cancel, ctx } = skills(crm);
    const out = (await cancel.run({}, ctx)) as { cancelled: boolean };
    expect(out.cancelled).toBe(false);
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
