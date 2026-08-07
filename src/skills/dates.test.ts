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

  it('resolves "this week" as a genuine multi-day range (never a single collapsed day)', () => {
    const r = resolveDateRange('this week', NOW)!; // NOW is a Saturday
    expect(r.to.getTime()).toBeGreaterThan(r.from.getTime());
    // Spans past today into at least the next day.
    expect(r.to.getDate()).toBeGreaterThan(r.from.getDate());
  });

  it('treats a bare weekday as the soonest one, including today', () => {
    // NOW is Saturday morning; "saturday" should mean today, not next week.
    const r = resolveDateRange('saturday', NOW)!;
    expect(r.from.getDate()).toBe(8);
  });

  it('returns null when the requested window already passed today', () => {
    const evening = new Date(2026, 7, 8, 18, 0, 0); // 6pm
    // "today afternoon" (12–17) is entirely in the past at 6pm → null (caller falls back).
    expect(resolveDateRange('today afternoon', evening)).toBeNull();
  });

  it('returns null for unrecognized input', () => {
    expect(resolveDateRange('whenever works for you', NOW)).toBeNull();
  });
});
