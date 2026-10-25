import { describe, expect, it } from "vitest";
import { appointmentCode, parseAppointmentCode, phoneDigits, minutesLabel } from "@/lib/constants";
import { checkMapUrl, extractCoordinates, resolveLocationLink } from "@/lib/maps";
import { contrastRatio, readableTextColor } from "@/lib/colors";
import { permissionsFor } from "@/lib/permissions";
import {
  addDaysToKey,
  addMonthsToKey,
  dateKey,
  dayRangeUtc,
  isValidDateString,
  minutesOfDay,
  overlaps,
  startOfWeekKey,
  timeKey,
  zonedToUtc,
} from "@/lib/time";
import { safeNextPath } from "@/lib/safe-redirect";
import { appointmentInputSchema, fieldErrorsFromZod, passwordSchema } from "@/lib/validation";

const settings = { salesCanViewReports: true, technicianCanSeeContacts: true };

describe("time helpers", () => {
  it("converts company-timezone wall time to UTC and back without shifting", () => {
    const utc = zonedToUtc("2026-01-15", "10:30", "Africa/Cairo"); // UTC+2 in winter
    expect(utc.toISOString()).toBe("2026-01-15T08:30:00.000Z");
    expect(timeKey(utc, "Africa/Cairo")).toBe("10:30");
    expect(dateKey(utc, "Africa/Cairo")).toBe("2026-01-15");
    expect(minutesOfDay(utc, "Africa/Cairo")).toBe(630);
    // Same wall time in Dubai is a different instant.
    expect(zonedToUtc("2026-01-15", "10:30", "Asia/Dubai").toISOString()).toBe("2026-01-15T06:30:00.000Z");
  });

  it("builds local-day ranges", () => {
    const r = dayRangeUtc("2026-01-15", "2026-01-15", "Africa/Cairo");
    expect(r.start.toISOString()).toBe("2026-01-14T22:00:00.000Z");
    expect(r.end.toISOString()).toBe("2026-01-15T22:00:00.000Z");
  });

  it("does calendar arithmetic on date keys", () => {
    expect(addDaysToKey("2026-02-28", 1)).toBe("2026-03-01");
    expect(addDaysToKey("2026-01-01", -1)).toBe("2025-12-31");
    expect(addMonthsToKey("2026-12-15", 1)).toBe("2027-01-01");
    expect(startOfWeekKey("2026-10-25", 6)).toBe("2026-10-24"); // Sunday -> previous Saturday
    expect(startOfWeekKey("2026-10-25", 0)).toBe("2026-10-25");
    expect(isValidDateString("2026-02-29")).toBe(false);
    expect(isValidDateString("2028-02-29")).toBe(true);
  });

  it("treats ranges as half-open", () => {
    const d = (h: number) => new Date(Date.UTC(2026, 0, 1, h));
    expect(overlaps(d(10), d(12), d(11), d(13))).toBe(true);
    expect(overlaps(d(10), d(12), d(12), d(13))).toBe(false);
    expect(overlaps(d(9), d(15), d(10), d(11))).toBe(true);
  });
});

describe("map links", () => {
  it("accepts http(s) links unchanged and rejects dangerous ones", () => {
    const url = "https://maps.app.goo.gl/AbC123?g_st=iw";
    expect(checkMapUrl(url)).toMatchObject({ ok: true, url, knownHost: true });
    expect(checkMapUrl("javascript:alert(1)").ok).toBe(false);
    expect(checkMapUrl("data:text/html,hi").ok).toBe(false);
    expect(checkMapUrl("https://user:pw@maps.google.com").ok).toBe(false);
    expect(checkMapUrl("not a url").ok).toBe(false);
    expect(checkMapUrl("https://example.com/place")).toMatchObject({ ok: true, knownHost: false });
  });

  it("extracts coordinates from common Google Maps URLs", () => {
    expect(extractCoordinates("https://www.google.com/maps/place/X/@30.0444,31.2357,17z")).toEqual({ latitude: 30.0444, longitude: 31.2357 });
    expect(extractCoordinates("https://maps.google.com/?q=29.96,31.25")).toEqual({ latitude: 29.96, longitude: 31.25 });
    expect(extractCoordinates("https://maps.app.goo.gl/abc")).toBeNull();
  });

  it("prefers the saved URL, falls back to coordinates, else null", () => {
    expect(resolveLocationLink({ mapUrl: "https://maps.app.goo.gl/x", latitude: 1, longitude: 2 })).toBe("https://maps.app.goo.gl/x");
    expect(resolveLocationLink({ latitude: "30.1", longitude: "31.2" })).toBe("https://www.google.com/maps/search/?api=1&query=30.1,31.2");
    expect(resolveLocationLink({ mapUrl: "javascript:x" })).toBeNull();
    expect(resolveLocationLink({})).toBeNull();
  });
});

describe("colours", () => {
  it("chooses readable text for any Sales colour", () => {
    expect(readableTextColor("#E55823")).toBe("#111111");
    expect(readableTextColor("#1E3A8A")).toBe("#FFFFFF");
    expect(readableTextColor("#FDE047")).toBe("#111111");
    for (const bg of ["#E55823", "#2563EB", "#059669", "#7C3AED", "#FDE047", "#000000", "#FFFFFF"]) {
      expect(contrastRatio(bg, readableTextColor(bg))).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("permissions", () => {
  it("matches the role definitions", () => {
    const admin = permissionsFor({ role: "ADMIN" }, settings);
    expect(admin.has("users.manage")).toBe(true);
    const sales = permissionsFor({ role: "SALES" }, settings);
    expect(sales.has("appointments.manage")).toBe(true);
    expect(sales.has("users.manage")).toBe(false);
    expect(sales.has("settings.manage")).toBe(false);
    expect(permissionsFor({ role: "SALES" }, { ...settings, salesCanViewReports: false }).has("reports.view")).toBe(false);
    const tech = permissionsFor({ role: "TECHNICIAN" }, settings);
    expect([...tech].sort()).toEqual(["appointments.view", "customers.contact", "location.view"]);
    expect(tech.has("appointments.manage")).toBe(false);
  });

  it("viewers only get grantable permissions, and inactive users get none", () => {
    const viewer = permissionsFor({ role: "VIEWER", viewerPermissions: ["appointments.view", "users.manage", "appointments.manage"] }, settings);
    expect([...viewer]).toEqual(["appointments.view"]);
    expect(permissionsFor({ role: "ADMIN", isActive: false }, settings).size).toBe(0);
  });
});

describe("validation", () => {
  const base = {
    customer: { name: "A", phone: "0100 123 4567" },
    location: {},
    productCategory: "SMART_LOCK",
    date: "2026-11-01",
    startTime: "09:00",
    durationMinutes: "90",
    technicianIds: [],
  };
  it("normalises empty optional fields and coerces duration", () => {
    const r = appointmentInputSchema.parse(base);
    expect(r.durationMinutes).toBe(90);
    expect(r.location.apartment).toBeNull();
    expect(r.brand).toBeNull();
  });
  it("reports field paths", () => {
    const r = appointmentInputSchema.safeParse({
      ...base,
      productCategory: "OTHER",
      startTime: "25:00",
      technicianIds: ["a", "a"],
      location: { latitude: "30" },
    });
    expect(r.success).toBe(false);
    const f = fieldErrorsFromZod(r.error!);
    expect(Object.keys(f).sort()).toEqual(["categoryOther", "location.longitude", "startTime", "technicianIds"]);
  });
  it("enforces the password policy", () => {
    expect(passwordSchema.safeParse("short1").success).toBe(false);
    expect(passwordSchema.safeParse("onlyletterslong").success).toBe(false);
    expect(passwordSchema.safeParse("Letters12345").success).toBe(true);
  });
});

describe("codes and formatting", () => {
  it("formats and parses appointment IDs", () => {
    expect(appointmentCode(42)).toBe("APT-000042");
    expect(parseAppointmentCode("APT-000042")).toBe(42);
    expect(parseAppointmentCode("apt42")).toBe(42);
    expect(parseAppointmentCode("#42")).toBe(42);
    expect(parseAppointmentCode("Ahmed")).toBeNull();
    expect(phoneDigits("+20 (100) 123-4567")).toBe("201001234567");
    expect(minutesLabel(150)).toBe("2 h 30 min");
  });
});

describe("post-login redirect", () => {
  it("only allows same-site relative paths", () => {
    expect(safeNextPath("/calendar?view=week")).toBe("/calendar?view=week");
    for (const bad of ["//evil.com", "/\\evil.com", "https://evil.com", "/api/users", "javascript:alert(1)", "/ok\u0000x", undefined]) {
      expect(safeNextPath(bad as string | undefined)).toBe("/");
    }
  });
});
