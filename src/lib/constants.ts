import type { CustomerConfirmation, LeaveType, PaymentMethod, ProductCategory, Role, StatusKind, StockStatus, VisitType } from "@prisma/client";
import { intlLocale, type Locale } from "@/i18n/config";
import type { T } from "@/i18n/translator";

export const DEFAULT_TIMEZONE = "Africa/Cairo";

export const ROLES: Role[] = ["ADMIN", "SALES", "TECHNICIAN", "ACCOUNTANT", "STORE", "VIEWER"];

export const STOCK_STATUSES: StockStatus[] = ["IN_STORE", "WITH_TECHNICIAN", "INSTALLED", "RETURNED", "FAULTY"];

/** Serials are compared without spaces and in upper case, so "ab 12" and "AB12" are the same item. */
export function normalizeSerial(raw: string): string {
  return raw.replace(/\s+/g, "").toUpperCase();
}

/**
 * One serial per line (commas, Arabic commas and semicolons also separate them); spaces inside a
 * serial are ignored, since printed serials are often grouped ("SN 1234 5678"). Duplicates dropped.
 */
export function parseSerials(text: string | null | undefined): string[] {
  return [...new Set((text ?? "").split(/[\r\n,،;]+/).map(normalizeSerial).filter(Boolean))];
}

export const SERIAL_RE = /^[A-Z0-9][A-Z0-9._/-]{0,63}$/;

export const PAYMENT_METHODS: PaymentMethod[] = ["CASH", "INSTAPAY", "VODAFONE_CASH", "BANK_TRANSFER"];

const moneyFormats = new Map<string, Intl.NumberFormat[]>();

/** Amounts are Egyptian pounds with up to two decimals ("1,250 EGP" / "1,250 ج.م"). */
export function money(n: number | null | undefined, locale: Locale): string {
  if (n === null || n === undefined) return "—";
  let f = moneyFormats.get(locale);
  if (!f) {
    const tag = intlLocale(locale);
    f = [new Intl.NumberFormat(tag, { maximumFractionDigits: 0 }), new Intl.NumberFormat(tag, { minimumFractionDigits: 2, maximumFractionDigits: 2 })];
    moneyFormats.set(locale, f);
  }
  const amount = f[Number.isInteger(n) ? 0 : 1]!.format(n);
  return locale === "ar" ? `${amount} ج.م` : `${amount} EGP`;
}

export const PRODUCT_CATEGORIES: ProductCategory[] = ["SMART_LOCK", "SMART_HOME", "CCTV", "INTERCOM", "OTHER"];

export const VISIT_TYPES: VisitType[] = ["INSTALLATION", "INSPECTION", "COMPLETION", "PROGRAMMING", "MAINTENANCE"];

export const CONFIRMATIONS: CustomerConfirmation[] = ["PENDING", "CONFIRMED", "RESCHEDULE_REQUESTED", "UNREACHABLE"];

export const LEAVE_TYPES: LeaveType[] = ["LEAVE", "SICK", "ABSENCE"];

export const STATUS_KINDS: StatusKind[] = [
  "SCHEDULED",
  "IN_PROGRESS",
  "COMPLETED",
  "POSTPONED",
  "CANCELLED",
  "UNABLE_TO_COMPLETE",
  "NEEDS_REVISIT",
];

export const DURATION_PRESETS = [30, 60, 90, 120, 180, 240, 360, 480];

/**
 * Calendar colours offered to admins for Sales employees, in assignment order. Validated as a
 * categorical palette (lightness band, chroma, colour-blind separation of neighbours, contrast)
 * on both light and dark surfaces. Colours are always shown next to the employee's name.
 */
export const SALES_COLOR_SUGGESTIONS = [
  "#E55823",
  "#2563EB",
  "#059669",
  "#7C3AED",
  "#A16207",
  "#0891B2",
  "#DB2777",
  "#65A30D",
];

export const FALLBACK_USER_COLOR = "#6B7280";

export function appointmentCode(num: number): string {
  return `APT-${String(num).padStart(6, "0")}`;
}

/** Accepts "APT-000123", "apt-123", "#123" or "123" and returns 123. */
export function parseAppointmentCode(input: string): number | null {
  const match = input.trim().match(/^(?:apt-?|#)?0*(\d{1,9})$/i);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function phoneDigits(phone: string): string {
  return phone.replace(/\D/g, "");
}

export function minutesLabel(total: number, t: T): string {
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h && m) return t("duration.hm", { h, m });
  if (h) return t("duration.h", { h });
  return t("duration.m", { m });
}
