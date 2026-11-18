import { describe, expect, it } from "vitest";
import { nextOccurrence, occurrences, stocktakeScheduleSchema } from "@/lib/stocktake-schedule";

describe("stocktake schedule occurrences", () => {
  it("once: only the start date", () => {
    expect(occurrences({ recurrence: "NONE", interval: 1, startDate: "2031-03-10", endDate: null }, "2031-03-01", "2031-03-31")).toEqual(["2031-03-10"]);
    expect(occurrences({ recurrence: "NONE", interval: 1, startDate: "2031-03-10", endDate: null }, "2031-03-11", "2031-03-31")).toEqual([]);
  });
  it("daily and every N days, from the start, within the window", () => {
    expect(occurrences({ recurrence: "DAILY", interval: 1, startDate: "2031-03-30", endDate: null }, "2031-03-01", "2031-04-02")).toEqual(["2031-03-30", "2031-03-31", "2031-04-01", "2031-04-02"]);
    expect(occurrences({ recurrence: "DAILY", interval: 3, startDate: "2031-03-01", endDate: null }, "2031-03-05", "2031-03-14")).toEqual(["2031-03-07", "2031-03-10", "2031-03-13"]);
  });
  it("weekly keeps the weekday", () => {
    expect(occurrences({ recurrence: "WEEKLY", interval: 2, startDate: "2031-03-04", endDate: null }, "2031-03-01", "2031-04-30")).toEqual(["2031-03-04", "2031-03-18", "2031-04-01", "2031-04-15", "2031-04-29"]);
  });
  it("monthly falls on the last day of shorter months", () => {
    expect(occurrences({ recurrence: "MONTHLY", interval: 1, startDate: "2031-01-31", endDate: null }, "2031-01-01", "2031-05-31")).toEqual(["2031-01-31", "2031-02-28", "2031-03-31", "2031-04-30", "2031-05-31"]);
    expect(occurrences({ recurrence: "MONTHLY", interval: 3, startDate: "2031-01-15", endDate: null }, "2031-02-01", "2031-12-31")).toEqual(["2031-04-15", "2031-07-15", "2031-10-15"]);
  });
  it("yearly, with 29 February in common years", () => {
    expect(occurrences({ recurrence: "YEARLY", interval: 1, startDate: "2032-02-29", endDate: null }, "2032-01-01", "2034-12-31")).toEqual(["2032-02-29", "2033-02-28", "2034-02-28"]);
    expect(nextOccurrence({ recurrence: "YEARLY", interval: 1, startDate: "2031-12-31", endDate: null }, "2032-01-01")).toBe("2032-12-31");
  });
  it("stops at the end date", () => {
    expect(occurrences({ recurrence: "DAILY", interval: 1, startDate: "2031-03-01", endDate: "2031-03-03" }, "2031-03-01", "2031-03-31")).toEqual(["2031-03-01", "2031-03-02", "2031-03-03"]);
    expect(nextOccurrence({ recurrence: "DAILY", interval: 1, startDate: "2031-03-01", endDate: "2031-03-03" }, "2031-03-04")).toBeNull();
  });
  it("validates schedules", () => {
    const base = { name: "Daily count", warehouseId: "w", kind: "DAILY", recurrence: "DAILY", startDate: "2031-03-01", endDate: null, startTime: "08:00", durationMinutes: 60, supervisorId: null };
    expect(stocktakeScheduleSchema.safeParse(base).success).toBe(true);
    expect(stocktakeScheduleSchema.safeParse({ ...base, startTime: "25:00" }).success).toBe(false);
    expect(stocktakeScheduleSchema.safeParse({ ...base, durationMinutes: 5 }).success).toBe(false);
    expect(stocktakeScheduleSchema.safeParse({ ...base, endDate: "2031-02-01" }).success).toBe(false);
    expect(stocktakeScheduleSchema.safeParse({ ...base, recurrence: "NONE", endDate: "2031-04-01" }).success).toBe(false);
    expect(stocktakeScheduleSchema.safeParse({ ...base, name: "  " }).success).toBe(false);
    expect(stocktakeScheduleSchema.safeParse({ ...base, interval: 0 }).success).toBe(false);
  });
});
