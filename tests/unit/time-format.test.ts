import { formatInTimeZone } from "date-fns-tz";
import { describe, expect, it } from "vitest";
import { fmt } from "@/lib/time";

// Every pattern the app formats with, plus a few that must fall back to date-fns-tz.
const PATTERNS = [
  "yyyy-MM-dd",
  "HH:mm",
  "EEEE d MMMM yyyy",
  "EEE d MMM yyyy",
  "d MMM yyyy, HH:mm",
  "EEE d MMM yyyy, HH:mm",
  "h:mm a",
  "yyyy-MM-dd'T'HH:mm",
  "MMMMM",
  "ddd",
];
const ZONES = ["Africa/Cairo", "UTC", "America/New_York", "Asia/Kolkata", "Australia/Lord_Howe", "Pacific/Kiritimati"];

describe("fmt (cached Intl fast path)", () => {
  it("matches date-fns-tz for every pattern, timezone and many instants (incl. DST changes)", () => {
    let state = 7;
    const rand = () => {
      state = (state * 1664525 + 1013904223) % 4294967296;
      return state / 4294967296;
    };
    const instants: Date[] = [];
    // Random instants over 2020-2035, plus every 15 minutes around known DST transitions.
    for (let i = 0; i < 1500; i++) instants.push(new Date(Date.UTC(2020, 0, 1) + Math.floor(rand() * 16 * 365 * 86_400_000)));
    for (const iso of ["2026-04-24T00:00:00Z", "2026-10-29T18:00:00Z", "2026-03-08T04:00:00Z", "2026-11-01T03:00:00Z", "2026-04-05T12:00:00Z"]) {
      const base = new Date(iso).getTime();
      for (let m = -6 * 60; m <= 6 * 60; m += 15) instants.push(new Date(base + m * 60_000));
    }
    instants.push(new Date("2026-12-31T23:59:59.999Z"), new Date("2027-01-01T00:00:00.000Z"));
    for (const tz of ZONES) {
      for (const pattern of PATTERNS) {
        for (const d of instants) {
          let expected: string;
          try {
            expected = formatInTimeZone(d, tz, pattern);
          } catch {
            continue; // invalid date-fns pattern: not our concern
          }
          expect(fmt(d, tz, pattern), `${tz} ${pattern} ${d.toISOString()}`).toBe(expected);
        }
      }
    }
  });

  it("accepts ISO strings", () => {
    expect(fmt("2026-10-25T07:05:00.000Z", "Africa/Cairo", "EEE d MMM yyyy, HH:mm")).toBe(
      formatInTimeZone(new Date("2026-10-25T07:05:00.000Z"), "Africa/Cairo", "EEE d MMM yyyy, HH:mm"),
    );
  });
});
