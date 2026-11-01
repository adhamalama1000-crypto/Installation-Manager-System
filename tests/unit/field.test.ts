import { describe, expect, it } from "vitest";
import { CLIENT_FAULT, distanceM, etaMinutes, minutesOf, monthlyPoints, PROBLEM_REASONS } from "@/lib/field";

describe("field rules from Aura", () => {
  it("measures great-circle distances in metres", () => {
    expect(distanceM({ lat: 30.0444, lng: 31.2357 }, { lat: 30.0444, lng: 31.2357 })).toBe(0);
    // Tahrir Square to the Cairo Tower is about 1.3 km.
    const d = distanceM({ lat: 30.0444, lng: 31.2357 }, { lat: 30.0459, lng: 31.2243 });
    expect(d).toBeGreaterThan(1050);
    expect(d).toBeLessThan(1150);
  });

  it("estimates the drive as straight line × 1.4 at Cairo speeds by hour, plus 5 minutes", () => {
    const from = { lat: 30.0, lng: 31.0 };
    const to = { lat: 30.09, lng: 31.0 }; // ~10 km north
    const km = (distanceM(from, to) / 1000) * 1.4;
    expect(etaMinutes(from, to, 6)).toBe(Math.round((km / 35) * 60 + 5));
    expect(etaMinutes(from, to, 8)).toBe(Math.round((km / 22) * 60 + 5));
    expect(etaMinutes(from, to, 12)).toBe(Math.round((km / 25) * 60 + 5));
    expect(etaMinutes(from, to, 17)).toBe(Math.round((km / 17) * 60 + 5));
    expect(etaMinutes(from, to, 21)).toBe(Math.round((km / 30) * 60 + 5));
    expect(etaMinutes(from, from, 12)).toBe(5);
  });

  it("scores the month like Aura and never goes below zero", () => {
    const base = { arrived: 0, onTime: 0, ratingAvg: null, gradeAvg: null, done: 0, revisits: 0, complaints: 0, lateDays: 0, absences: 0 };
    expect(monthlyPoints(base)).toBe(0);
    expect(monthlyPoints({ ...base, arrived: 10, onTime: 10, ratingAvg: 5, gradeAvg: 5, done: 25 })).toBe(100);
    expect(monthlyPoints({ ...base, arrived: 4, onTime: 3, ratingAvg: 4, gradeAvg: 3, done: 6 })).toBe(30 + 24 + 12 + 6);
    expect(monthlyPoints({ ...base, arrived: 4, onTime: 3, ratingAvg: 4, gradeAvg: 3, done: 6, revisits: 1, complaints: 1, lateDays: 2, absences: 1 })).toBe(72 - 5 - 10 - 4 - 5);
    expect(monthlyPoints({ ...base, done: 2, complaints: 3 })).toBe(0);
  });

  it("keeps Aura's problem reasons, the first four being the customer's fault", () => {
    expect(PROBLEM_REASONS).toHaveLength(5);
    expect(CLIENT_FAULT).not.toContain("missingParts");
    expect(minutesOf("10:15")).toBe(615);
  });
});
