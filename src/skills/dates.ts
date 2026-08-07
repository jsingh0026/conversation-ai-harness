/**
 * Resolve a natural relative time expression ("tomorrow afternoon", "this week",
 * "friday morning") into an absolute [from, to] range, relative to `now`. Used
 * by the appointment skill so the agent can honor relative asks. Returns null
 * when nothing is recognized, so the caller can fall back to a default window.
 *
 * Uses local time throughout; `now` is injected so it's fully deterministic.
 */
export interface DateRange {
  from: Date;
  to: Date;
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const PARTS_OF_DAY: Record<string, [number, number]> = {
  morning: [8, 12],
  afternoon: [12, 17],
  evening: [17, 21],
};

const startOfDay = (d: Date): Date => {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c;
};
const endOfDay = (d: Date): Date => {
  const c = new Date(d);
  c.setHours(23, 59, 59, 999);
  return c;
};
const addDays = (d: Date, n: number): Date => {
  const c = new Date(d);
  c.setDate(c.getDate() + n);
  return c;
};
const atHour = (d: Date, h: number): Date => {
  const c = new Date(d);
  c.setHours(h, 0, 0, 0);
  return c;
};

/** Days until the next occurrence of `targetDow` (0 = today, so a bare weekday
 * means the soonest one — the past-of-day is dropped by the future clamp). */
function daysUntilWeekday(now: Date, targetDow: number): number {
  return (targetDow - now.getDay() + 7) % 7;
}

export function resolveDateRange(when: string, now: Date): DateRange | null {
  const w = when.toLowerCase();

  // Multi-day ranges resolve and return directly.
  if (w.includes('this week')) {
    // Now through the end of the coming Sunday, always at least ~2 days so it's
    // never a degenerate single partial day (e.g. asked on a Saturday).
    const daysToSunday = (7 - now.getDay()) % 7;
    const to = endOfDay(addDays(now, Math.max(daysToSunday, 1)));
    return clampFuture({ from: now, to }, now);
  }
  if (w.includes('next week')) {
    const toMonday = daysUntilWeekday(now, 1);
    const nextMonday = startOfDay(addDays(now, toMonday === 0 ? 7 : toMonday));
    return clampFuture({ from: nextMonday, to: endOfDay(addDays(nextMonday, 6)) }, now);
  }

  // Single-day ranges, optionally narrowed to a part of the day.
  let dayStart: Date | null = null;
  if (w.includes('today') || w.includes('tonight')) {
    dayStart = startOfDay(now);
  } else if (w.includes('tomorrow')) {
    dayStart = startOfDay(addDays(now, 1));
  } else {
    const dow = WEEKDAYS.findIndex((name) => w.includes(name));
    if (dow >= 0) dayStart = startOfDay(addDays(now, daysUntilWeekday(now, dow)));
  }
  if (!dayStart) return null;

  let from = dayStart;
  let to = endOfDay(dayStart);
  for (const [part, [h0, h1]] of Object.entries(PARTS_OF_DAY)) {
    if (w.includes(part)) {
      from = atHour(dayStart, h0);
      to = atHour(dayStart, h1);
      break;
    }
  }

  return clampFuture({ from, to }, now);
}

/**
 * Never offer times in the past. If clamping `from` up to `now` leaves the
 * window empty or inverted (the whole window already passed today, e.g. "today
 * afternoon" asked at 6pm), return null so the caller falls back to a forward
 * window rather than passing from > to to the calendar.
 */
function clampFuture(range: DateRange, now: Date): DateRange | null {
  const from = range.from < now ? now : range.from;
  if (from >= range.to) return null;
  return { from, to: range.to };
}
