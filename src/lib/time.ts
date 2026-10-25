/**
 * Date/time helpers. All appointment times are stored as UTC instants (timestamptz) and are
 * always entered and displayed in the company timezone configured in Settings - never in the
 * browser's local timezone - so every user sees the same wall-clock time.
 */
import { addMinutes } from "date-fns";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function isValidDateString(date: string): boolean {
  if (!DATE_RE.test(date)) return false;
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m! - 1 && dt.getUTCDate() === d;
}

/** Converts a wall-clock date + time in `tz` to a UTC instant. */
export function zonedToUtc(date: string, time: string, tz: string): Date {
  return fromZonedTime(`${date}T${time}:00`, tz);
}

export function computeEnd(startsAt: Date, durationMinutes: number): Date {
  return addMinutes(startsAt, durationMinutes);
}

export function fmt(date: Date | string, tz: string, pattern: string): string {
  return formatInTimeZone(typeof date === "string" ? new Date(date) : date, tz, pattern);
}

/** "2026-10-25" in the given timezone. */
export function dateKey(date: Date | string, tz: string): string {
  return fmt(date, tz, "yyyy-MM-dd");
}

export function timeKey(date: Date | string, tz: string): string {
  return fmt(date, tz, "HH:mm");
}

/** Minutes since local midnight in `tz`. */
export function minutesOfDay(date: Date | string, tz: string): number {
  const [h, m] = timeKey(date, tz).split(":").map(Number);
  return h! * 60 + m!;
}

export function todayKey(tz: string, now: Date = new Date()): string {
  return dateKey(now, tz);
}

/** Adds whole calendar days to a "yyyy-MM-dd" key (timezone independent). */
export function addDaysToKey(key: string, days: number): string {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

/** 0 = Sunday ... 6 = Saturday for a "yyyy-MM-dd" key. */
export function weekdayOfKey(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
}

export function startOfWeekKey(key: string, weekStartsOn: number): string {
  const diff = (weekdayOfKey(key) - weekStartsOn + 7) % 7;
  return addDaysToKey(key, -diff);
}

export function startOfMonthKey(key: string): string {
  return `${key.slice(0, 7)}-01`;
}

export function addMonthsToKey(key: string, months: number): string {
  const [y, m] = key.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1 + months, 1));
  return dt.toISOString().slice(0, 10);
}

export function daysInMonthOfKey(key: string): number {
  const [y, m] = key.split("-").map(Number);
  return new Date(Date.UTC(y!, m!, 0)).getUTCDate();
}

/** UTC instant of local midnight at the start of `key` in `tz`. */
export function startOfDayUtc(key: string, tz: string): Date {
  return zonedToUtc(key, "00:00", tz);
}

/** Half-open UTC range [start, end) covering the local days from `fromKey` to `toKey` inclusive. */
export function dayRangeUtc(fromKey: string, toKey: string, tz: string): { start: Date; end: Date } {
  return { start: startOfDayUtc(fromKey, tz), end: startOfDayUtc(addDaysToKey(toKey, 1), tz) };
}

/** Human readable day label for a key, rendered without timezone conversion. */
export function formatKey(key: string, pattern: Intl.DateTimeFormatOptions): string {
  const [y, m, d] = key.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", { ...pattern, timeZone: "UTC" }).format(new Date(Date.UTC(y!, m! - 1, d!)));
}

export function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && bStart < aEnd;
}
