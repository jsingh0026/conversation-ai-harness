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

/** Days until the next occurrence of `targetDow` (1–7; today counts as next week). */
function daysUntilWeekday(now: Date, targetDow: number): number {
  const diff = (targetDow - now.getDay() + 7) % 7;
  return diff === 0 ? 7 : diff;
}

export function resolveDateRange(when: string, now: Date): DateRange | null {
  const w = when.toLowerCase();

  // Multi-day ranges resolve and return directly.
  if (w.includes('this week')) {
    const to = endOfDay(addDays(startOfDay(now), 6 - now.getDay())); // through Saturday
    return clampFuture({ from: startOfDay(now), to }, now);
  }
  if (w.includes('next week')) {
    const nextMonday = startOfDay(addDays(now, daysUntilWeekday(now, 1)));
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

/** Never offer times in the past. */
function clampFuture(range: DateRange, now: Date): DateRange {
  return { from: range.from < now ? now : range.from, to: range.to };
}
