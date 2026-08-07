import { describe, expect, it } from 'vitest';
import { MockCrmClient, SlotTakenError } from './mock.js';

describe('MockCrmClient', () => {
  it('records sent messages', async () => {
    const crm = new MockCrmClient();
    await crm.sendMessage({ conversationId: 'c1', contactId: 'ct1', channel: 'SMS', body: 'hi' });
    expect(crm.lastSent()?.body).toBe('hi');
  });

  it('updates contact fields, creating the contact if missing', async () => {
    const crm = new MockCrmClient();
    const c = await crm.updateContactFields('ct1', { budget: 500000 });
    expect(c.fields.budget).toBe(500000);
  });

  it('adds tags idempotently', async () => {
    const crm = new MockCrmClient();
    crm.upsertContact({ id: 'ct1' });
    await crm.addTag('ct1', 'bot-handover');
    await crm.addTag('ct1', 'bot-handover');
    expect((await crm.getContact('ct1')).tags).toEqual(['bot-handover']);
  });

  it('bot is enabled by default and can be turned off', async () => {
    const crm = new MockCrmClient();
    expect(await crm.isBotEnabled('c1')).toBe(true);
    await crm.setBotEnabled('c1', false);
    expect(await crm.isBotEnabled('c1')).toBe(false);
  });

  it('books an open slot and removes it', async () => {
    const slot = { startTime: '2026-08-10T15:00:00Z', endTime: '2026-08-10T15:30:00Z' };
    const crm = new MockCrmClient({ slots: { cal1: [slot] } });
    const appt = await crm.createAppointment({ calendarId: 'cal1', contactId: 'ct1', ...slot });
    expect(appt.status).toBe('booked');
    expect(await crm.getFreeSlots('cal1', '2026-08-10T00:00:00Z', '2026-08-11T00:00:00Z')).toHaveLength(
      0,
    );
  });

  it('throws SlotTakenError when the slot is gone', async () => {
    const crm = new MockCrmClient({ slots: { cal1: [] } });
    await expect(
      crm.createAppointment({
        calendarId: 'cal1',
        contactId: 'ct1',
        startTime: '2026-08-10T15:00:00Z',
        endTime: '2026-08-10T15:30:00Z',
      }),
    ).rejects.toBeInstanceOf(SlotTakenError);
  });
});
