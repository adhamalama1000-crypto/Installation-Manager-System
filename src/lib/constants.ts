import type { CustomerConfirmation, LeaveStatus, LeaveType, ProductCategory, Role, StatusKind, VisitType } from "@prisma/client";

export const APP_NAME = "Installation Manager System";

export const DEFAULT_TIMEZONE = "Africa/Cairo";

export const ROLE_LABELS: Record<Role, string> = {
  ADMIN: "Admin",
  SALES: "Sales",
  TECHNICIAN: "Technician",
  VIEWER: "Viewer",
};

export const ROLES: Role[] = ["ADMIN", "SALES", "TECHNICIAN", "VIEWER"];

export const PRODUCT_CATEGORY_LABELS: Record<ProductCategory, string> = {
  SMART_LOCK: "Smart Lock",
  SMART_HOME: "Smart Home",
  CCTV: "CCTV",
  INTERCOM: "Intercom",
  OTHER: "Other",
};

export const PRODUCT_CATEGORIES: ProductCategory[] = ["SMART_LOCK", "SMART_HOME", "CCTV", "INTERCOM", "OTHER"];

export const VISIT_TYPE_LABELS: Record<VisitType, string> = {
  INSPECTION: "Inspection",
  INSTALLATION: "Installation",
  COMPLETION: "Completion",
  PROGRAMMING: "Programming",
  MAINTENANCE: "Maintenance",
};

export const VISIT_TYPES: VisitType[] = ["INSTALLATION", "INSPECTION", "COMPLETION", "PROGRAMMING", "MAINTENANCE"];

export const CONFIRMATION_LABELS: Record<CustomerConfirmation, string> = {
  PENDING: "Awaiting confirmation",
  CONFIRMED: "Confirmed by customer",
  RESCHEDULE_REQUESTED: "Customer asked to reschedule",
  UNREACHABLE: "Customer unreachable",
};

export const CONFIRMATIONS: CustomerConfirmation[] = ["PENDING", "CONFIRMED", "RESCHEDULE_REQUESTED", "UNREACHABLE"];

export const LEAVE_TYPE_LABELS: Record<LeaveType, string> = {
  LEAVE: "Leave",
  SICK: "Sick leave",
  ABSENCE: "Absence",
};

export const LEAVE_TYPES: LeaveType[] = ["LEAVE", "SICK", "ABSENCE"];

export const LEAVE_STATUS_LABELS: Record<LeaveStatus, string> = {
  REQUESTED: "Awaiting approval",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  CANCELLED: "Cancelled",
};

export const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export const STATUS_KIND_LABELS: Record<StatusKind, string> = {
  SCHEDULED: "Scheduled",
  IN_PROGRESS: "In Progress",
  COMPLETED: "Completed",
  POSTPONED: "Postponed / Rescheduled",
  CANCELLED: "Cancelled",
  UNABLE_TO_COMPLETE: "Unable to Complete",
  NEEDS_REVISIT: "Needs another visit",
};

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

export function minutesLabel(total: number): string {
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h && m) return `${h} h ${m} min`;
  if (h) return `${h} h`;
  return `${m} min`;
}
