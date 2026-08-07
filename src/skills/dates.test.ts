import { describe, expect, it } from 'vitest';
import { resolveDateRange } from './dates.js';

// A fixed reference: Saturday, 2026-08-08, 10:00 local.
const NOW = new Date(2026, 7, 8, 10, 0, 0);

describe('resolveDateRange', () => {
  it('resolves "tomorrow afternoon" to the next day, 12:00–17:00', () => {
    const r = resolveDateRange('tomorrow afternoon', NOW)!;
    expect(r.from.getDate()).toBe(9);
    expect(r.from.getHours()).toBe(12);
    expect(r.to.getHours()).toBe(17);
  });

  it('resolves "today" but never offers a time in the past', () => {
    const r = resolveDateRange('today', NOW)!;
    // Start clamps to now (10:00), not midnight.
    expect(r.from.getTime()).toBe(NOW.getTime());
    expect(r.to.getDate()).toBe(8);
  });

  it('resolves a weekday to its next occurrence', () => {
    // NOW is Saturday; next Monday is the 10th.
    const r = resolveDateRange('monday morning', NOW)!;
    expect(r.from.getDate()).toBe(10);
    expect(r.from.getHours()).toBe(8);
    expect(r.to.getHours()).toBe(12);
  });

  it('resolves "this week" as a multi-day range through the weekend', () => {
    const r = resolveDateRange('this week', NOW)!;
    expect(r.to.getTime()).toBeGreaterThan(r.from.getTime());
    expect(r.to.getDate()).toBeGreaterThanOrEqual(8);
  });

  it('returns null for unrecognized input', () => {
    expect(resolveDateRange('whenever works for you', NOW)).toBeNull();
  });
});
