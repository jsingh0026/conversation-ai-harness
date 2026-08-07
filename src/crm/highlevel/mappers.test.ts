import { describe, expect, it } from 'vitest';
import { mapContact, parseFreeSlots, shiftIso, toHlMessageType } from './mappers.js';

describe('mapContact', () => {
  it('composes a name and maps custom fields by id', () => {
    const c = mapContact({
      id: 'ct1',
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      tags: ['vip'],
      assignedTo: 'user-9',
      customFields: [{ id: 'fld_budget', value: 750000 }],
    });
    expect(c.name).toBe('Ada Lovelace');
    expect(c.email).toBe('ada@example.com');
    expect(c.tags).toEqual(['vip']);
    expect(c.assignedUserId).toBe('user-9');
    expect(c.fields.fld_budget).toBe(750000);
  });

  it('tolerates missing fields', () => {
    const c = mapContact({ id: 'ct1' });
    expect(c.tags).toEqual([]);
    expect(c.name).toBeUndefined();
  });
});

describe('parseFreeSlots', () => {
  it('flattens date-keyed slots and computes end times, ignoring traceId', () => {
    const slots = parseFreeSlots(
      {
        '2026-08-09': { slots: ['2026-08-09T15:00:00.000Z', '2026-08-09T16:00:00.000Z'] },
        '2026-08-10': { slots: ['2026-08-10T10:00:00.000Z'] },
        traceId: 'abc',
      },
      30,
    );
    expect(slots).toHaveLength(3);
    expect(slots[0]).toEqual({
      startTime: '2026-08-09T15:00:00.000Z',
      endTime: '2026-08-09T15:30:00.000Z',
    });
    // sorted ascending
    expect(Date.parse(slots[2]!.startTime)).toBeGreaterThan(Date.parse(slots[0]!.startTime));
  });

  it('drops unparseable slot strings', () => {
    expect(parseFreeSlots({ '2026-08-09': { slots: ['not-a-date'] } })).toHaveLength(0);
  });

  it('preserves the offset (does not flatten local time to UTC)', () => {
    const slots = parseFreeSlots({ '2026-08-09': { slots: ['2026-08-09T09:00:00-04:00'] } }, 30);
    expect(slots[0]).toEqual({
      startTime: '2026-08-09T09:00:00-04:00',
      endTime: '2026-08-09T09:30:00-04:00',
    });
  });
});

describe('shiftIso', () => {
  it('adds minutes while keeping the UTC offset', () => {
    expect(shiftIso('2026-08-09T09:00:00-04:00', 30)).toBe('2026-08-09T09:30:00-04:00');
    expect(shiftIso('2026-08-09T15:00:00.000Z', 30)).toBe('2026-08-09T15:30:00.000Z');
    // crosses the hour with a positive offset
    expect(shiftIso('2026-08-09T09:45:00+05:30', 30)).toBe('2026-08-09T10:15:00+05:30');
  });
});

describe('toHlMessageType', () => {
  it('maps known channels and defaults to SMS', () => {
    expect(toHlMessageType('Email')).toBe('Email');
    expect(toHlMessageType('anything-else')).toBe('SMS');
  });
});
