import { describe, expect, it } from "vitest";
import { nextSlots, retryDelayMs, tzOffsetMinutes, zonedToUtc } from "../src/schedule-logic";

describe("retryDelayMs", () => {
  it("doubles each attempt, capped at 60 minutes", () => {
    const noJitter = () => 0;
    expect(retryDelayMs(1, noJitter)).toBe(60_000);
    expect(retryDelayMs(2, noJitter)).toBe(2 * 60_000);
    expect(retryDelayMs(3, noJitter)).toBe(4 * 60_000);
    expect(retryDelayMs(10, noJitter)).toBe(60 * 60_000);
  });

  it("adds at most 20% jitter", () => {
    const max = retryDelayMs(3, () => 0.999999);
    expect(max).toBeLessThanOrEqual(Math.round(4 * 60_000 * 1.2));
    expect(max).toBeGreaterThan(4 * 60_000);
  });
});

describe("timezones", () => {
  it("Asia/Kolkata is +330 minutes with no daylight saving", () => {
    expect(tzOffsetMinutes("Asia/Kolkata", new Date("2026-01-01T00:00:00Z"))).toBe(330);
    expect(tzOffsetMinutes("Asia/Kolkata", new Date("2026-07-01T00:00:00Z"))).toBe(330);
  });

  it("converts local 09:00 Kolkata to 03:30 UTC", () => {
    expect(zonedToUtc("2026-11-16", "09:00", "Asia/Kolkata").toISOString()).toBe("2026-11-16T03:30:00.000Z");
  });
});

describe("nextSlots", () => {
  const from = new Date("2026-11-15T10:00:00Z"); // 15:30 in Kolkata

  it("skips times already past and fills the next day", () => {
    const slots = nextSlots({ from, times: ["09:00", "13:00", "18:30"], timeZone: "Asia/Kolkata", count: 4, taken: new Set() });
    expect(slots.map((s) => s.toISOString())).toEqual([
      "2026-11-15T13:00:00.000Z", // 18:30 IST today (13:00 UTC)
      "2026-11-16T03:30:00.000Z", // 09:00 tomorrow
      "2026-11-16T07:30:00.000Z", // 13:00 tomorrow
      "2026-11-16T13:00:00.000Z", // 18:30 tomorrow
    ]);
  });

  it("never double-books a taken slot", () => {
    const taken = new Set([zonedToUtc("2026-11-15", "18:30", "Asia/Kolkata").getTime()]);
    const slots = nextSlots({ from, times: ["09:00", "13:00", "18:30"], timeZone: "Asia/Kolkata", count: 1, taken });
    expect(slots[0].toISOString()).toBe("2026-11-16T03:30:00.000Z");
  });

  it("returns nothing when no times are configured", () => {
    expect(nextSlots({ from, times: [], timeZone: "Asia/Kolkata", count: 3, taken: new Set() })).toEqual([]);
  });
});
