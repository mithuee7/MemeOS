// Pure scheduling and retry rules. No I/O here, so they are easy to test.

// Exponential backoff with jitter: 1, 2, 4, 8 ... minutes, capped at 60, plus up to 20% random jitter.
export function retryDelayMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(60, 2 ** Math.max(0, attempt - 1)) * 60_000;
  return Math.round(base + base * 0.2 * random());
}

// Offset in minutes between UTC and a named IANA timezone at a given instant.
export function tzOffsetMinutes(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
}

// Converts a wall-clock "YYYY-MM-DD" + "HH:MM" in a timezone to a UTC Date.
export function zonedToUtc(day: string, hhmm: string, timeZone: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  const [hh, mm] = hhmm.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const offset = tzOffsetMinutes(timeZone, new Date(guess));
  return new Date(guess - offset * 60_000);
}

// Returns the next `count` free publishing slots after `from`, using the account's daily times.
// `taken` holds ISO timestamps already in use so slots are never double-booked.
export function nextSlots(opts: {
  from: Date;
  times: string[];
  timeZone: string;
  count: number;
  taken: Set<number>;
  maxDays?: number;
}): Date[] {
  const { from, times, timeZone, count, taken } = opts;
  const out: Date[] = [];
  const maxDays = opts.maxDays ?? 60;
  // Start at the local calendar day of `from`.
  const local = new Date(from.getTime() + tzOffsetMinutes(timeZone, from) * 60_000);
  for (let day = 0; day < maxDays && out.length < count; day++) {
    const d = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + day));
    const label = d.toISOString().slice(0, 10);
    const sorted = [...times].sort();
    for (const t of sorted) {
      if (out.length >= count) break;
      const slot = zonedToUtc(label, t, timeZone);
      if (slot.getTime() <= from.getTime()) continue;
      if (taken.has(slot.getTime())) continue;
      out.push(slot);
    }
  }
  return out;
}

export const JOB_MAX_ATTEMPTS = 5;
