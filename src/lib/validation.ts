/**
 * Zod schemas shared by the browser (instant feedback) and the API (authoritative validation).
 */
import { z } from "zod";
import { msg, type MessageKey } from "@/i18n/translator";
import { HEX_COLOR_RE } from "./colors";
import { CONFIRMATIONS, LEAVE_TYPES, PAYMENT_METHODS, PRODUCT_CATEGORIES, ROLES, SERIAL_RE, STATUS_KINDS, VISIT_TYPES, parseSerials, phoneDigits } from "./constants";
import { checkMapUrl, isValidLatitude, isValidLongitude } from "./maps";
import { VIEWER_GRANTABLE } from "./permissions";
import { TIME_RE, isValidDateString, isValidTimeZone } from "./time";

// Messages are translation keys (see i18n/translator `msg`); forms and the API translate them.
// Zod's own English texts only appear for input the UI cannot produce, so they become one generic message.
z.config({ customError: () => msg("validation.invalid") });

const maxChars = (max: number) => msg("validation.maxChars", { max });

/** Optional free text: trims, turns "" into null, enforces a max length. */
export const optionalText = (max: number) =>
  z.preprocess(
    (v) => (typeof v === "string" ? v.trim() || null : (v ?? null)),
    z.string().max(max, maxChars(max)).nullable(),
  );

const requiredText = (label: MessageKey, max: number) => {
  const required = msg("validation.required", { field: `@${label}` });
  return z.preprocess((v) => (typeof v === "string" ? v.trim() : v), z.string({ error: required }).min(1, required).max(max, maxChars(max)));
};

const phoneField = (label: MessageKey) =>
  requiredText(label, 30)
    .refine((v) => /^[+\d\s().-]+$/.test(v), msg("validation.phoneChars"))
    .refine((v) => {
      const n = phoneDigits(v).length;
      return n >= 7 && n <= 15;
    }, msg("validation.phoneDigits"));

const optionalPhone = z.preprocess(
  (v) => (typeof v === "string" ? v.trim() || null : (v ?? null)),
  z
    .string()
    .max(30)
    .refine((v) => /^[+\d\s().-]+$/.test(v), msg("validation.phoneChars"))
    .refine((v) => {
      const n = phoneDigits(v).length;
      return n >= 7 && n <= 15;
    }, msg("validation.phoneDigits"))
    .nullable(),
);

const optionalNumber = z.preprocess((v) => {
  if (v === "" || v === null || v === undefined) return null;
  return typeof v === "string" ? Number(v.trim()) : v;
}, z.number({ error: msg("validation.number") }).nullable());

const idField = z.string().min(1).max(64);

/** An amount in EGP: blank = not recorded (null); commas and spaces are ignored. */
const moneyField = z.preprocess(
  (v) => {
    if (v === "" || v === null || v === undefined) return v === undefined ? undefined : null;
    return typeof v === "string" ? Number(v.replace(/[,\s]/g, "")) : v;
  },
  z
    .number({ error: msg("validation.amount") })
    .min(0, msg("validation.negative"))
    .max(10_000_000, msg("validation.tooLarge"))
    .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, msg("validation.twoDecimals"))
    .nullable()
    .optional(),
);

/** Serial numbers typed one per line (or separated by commas/spaces), normalised and checked. */
const serialsField = z.preprocess(
  (v) => (Array.isArray(v) ? parseSerials(v.join("\n")) : typeof v === "string" ? parseSerials(v) : v),
  z
    .array(z.string())
    .max(200, msg("validation.maxSerials"))
    .superRefine((list, ctx) => {
      const bad = list.filter((s) => !SERIAL_RE.test(s));
      if (bad.length) ctx.addIssue({ code: "custom", message: msg("validation.badSerial", { list: bad.slice(0, 5).join(", ") }) });
    }),
);

const paymentMethodField = z.preprocess(
  (v) => (v === "" ? null : v),
  z.enum(PAYMENT_METHODS as [string, ...string[]], { error: msg("validation.paymentMethod") }).nullable().optional(),
);

export const customerInputSchema = z.object({
  id: idField.optional().nullable(),
  name: requiredText("fields.customerName", 120),
  phone: phoneField("fields.primaryPhone"),
  secondaryPhone: optionalPhone,
});

export const locationInputSchema = z
  .object({
    id: idField.optional().nullable(),
    area: optionalText(120),
    streetAddress: optionalText(300),
    building: optionalText(120),
    apartment: optionalText(30),
    floor: optionalText(30),
    accessInstructions: optionalText(1000),
    mapUrl: optionalText(2048).refine((v) => v === null || checkMapUrl(v).ok, {
      message: msg("validation.mapUrl"),
    }),
    latitude: optionalNumber.refine((v) => v === null || isValidLatitude(v), msg("validation.latitude")),
    longitude: optionalNumber.refine((v) => v === null || isValidLongitude(v), msg("validation.longitude")),
  })
  .superRefine((loc, ctx) => {
    if ((loc.latitude === null) !== (loc.longitude === null)) {
      ctx.addIssue({
        code: "custom",
        path: [loc.latitude === null ? "latitude" : "longitude"],
        message: msg("validation.latLngPair"),
      });
    }
  });

export const appointmentInputSchema = z
  .object({
    clientRequestId: z.uuid().optional().nullable(),
    version: z.number().int().positive().optional(),
    /** Admin only: create on behalf of a Sales employee. Ignored for other roles. */
    salesUserId: idField.optional().nullable(),
    customer: customerInputSchema,
    location: locationInputSchema,
    productCategory: z.enum(PRODUCT_CATEGORIES as [string, ...string[]], { error: msg("validation.category") }),
    visitType: z.preprocess((v) => (v === "" ? null : v), z.enum(VISIT_TYPES as [string, ...string[]], { error: msg("validation.visitType") }).nullable().optional()),
    customerConfirmation: z.enum(CONFIRMATIONS as [string, ...string[]]).optional(),
    /** Create only: the earlier appointment this visit follows up. */
    followUpOfId: idField.optional().nullable(),
    /** Admin only: book on a weekday configured as closed. */
    allowClosedDay: z.boolean().optional(),
    categoryOther: optionalText(120),
    brand: optionalText(120),
    model: optionalText(120),
    description: optionalText(4000),
    requiredEquipment: optionalText(2000),
    additionalNotes: optionalText(4000),
    internalNotes: optionalText(4000),
    date: z.string({ error: msg("validation.dateRequired") }).refine(isValidDateString, msg("validation.date")),
    startTime: z.string({ error: msg("validation.timeRequired") }).regex(TIME_RE, msg("validation.time")),
    durationMinutes: z.coerce
      .number({ error: msg("validation.durationRequired") })
      .int(msg("validation.durationWhole"))
      .min(15, msg("validation.durationMin"))
      .max(1440, msg("validation.durationMax")),
    technicianIds: z
      .array(idField)
      .max(10, msg("validation.maxTechnicians"))
      .refine((ids) => new Set(ids).size === ids.length, msg("validation.technicianTwice")),
    statusId: idField.optional().nullable(),
    /** Money (left out = unchanged on edit, blank = not recorded). */
    totalPrice: moneyField,
    depositAmount: moneyField,
    depositMethod: paymentMethodField,
    extraFee: moneyField,
  })
  .superRefine((a, ctx) => {
    if (a.productCategory === "OTHER" && !a.categoryOther) {
      ctx.addIssue({ code: "custom", path: ["categoryOther"], message: msg("validation.categoryOther") });
    }
    if (a.depositAmount) {
      if (a.totalPrice === null || a.totalPrice === undefined) ctx.addIssue({ code: "custom", path: ["totalPrice"], message: msg("validation.totalForDeposit") });
      else if (a.depositAmount > a.totalPrice) ctx.addIssue({ code: "custom", path: ["depositAmount"], message: msg("validation.depositTooHigh") });
      if (!a.depositMethod) ctx.addIssue({ code: "custom", path: ["depositMethod"], message: msg("validation.depositMethod") });
    }
  });

export type AppointmentInput = z.output<typeof appointmentInputSchema>;
export type AppointmentFormValues = z.input<typeof appointmentInputSchema>;

export const statusChangeSchema = z.object({
  statusId: idField,
  version: z.number().int().positive().optional(),
  note: optionalText(1000),
});

/** Outcomes a technician can record for a visit; every outcome except "started" needs a report. */
export const VISIT_OUTCOMES = ["IN_PROGRESS", "COMPLETED", "UNABLE_TO_COMPLETE", "NEEDS_REVISIT"] as const;
export type VisitOutcome = (typeof VISIT_OUTCOMES)[number];

export const outcomeSchema = z
  .object({
    outcome: z.enum(VISIT_OUTCOMES, { error: msg("validation.outcome") }),
    report: optionalText(4000),
    /** Paid by the customer at this visit (left out = unchanged). */
    collectedAmount: moneyField,
    collectedMethod: paymentMethodField,
    /** Serial numbers installed at this visit (added to what is already recorded). */
    serials: serialsField.optional(),
    version: z.number().int().positive().optional(),
  })
  .superRefine((o, ctx) => {
    if (o.outcome !== "IN_PROGRESS" && !o.report) {
      ctx.addIssue({ code: "custom", path: ["report"], message: msg("validation.reportRequired") });
    }
    if (o.outcome === "IN_PROGRESS" && o.collectedAmount) {
      ctx.addIssue({ code: "custom", path: ["collectedAmount"], message: msg("validation.paymentAtFinish") });
    }
    if (o.collectedAmount && !o.collectedMethod) {
      ctx.addIssue({ code: "custom", path: ["collectedMethod"], message: msg("validation.collectedMethod") });
    }
    if (o.serials?.length && o.outcome !== "COMPLETED") {
      ctx.addIssue({ code: "custom", path: ["serials"], message: msg("validation.serialsAtFinish") });
    }
  });

export const productModelSchema = z.object({
  name: z.preprocess((v) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ") : v), z.string({ error: msg("validation.modelName") }).min(1, msg("validation.modelName")).max(120)),
  category: z.enum(PRODUCT_CATEGORIES as [string, ...string[]], { error: msg("validation.category") }),
  warrantyMonths: z.coerce.number({ error: msg("validation.warranty") }).int(msg("validation.wholeMonths")).min(0, msg("validation.negative")).max(120, msg("validation.max120Months")),
  isActive: z.boolean().optional(),
});

export const stockInSchema = z.object({
  modelId: z.string({ error: msg("validation.chooseModel") }).min(1, msg("validation.chooseModel")).max(64),
  serials: serialsField.refine((l) => l.length > 0, msg("validation.serialsRequired")),
  note: optionalText(500),
});

export const STOCK_MOVE_TARGETS = ["IN_STORE", "WITH_TECHNICIAN", "RETURNED", "FAULTY"] as const;

export const stockMoveSchema = z
  .object({
    itemIds: z.array(idField).min(1, msg("validation.chooseItems")).max(500),
    to: z.enum(STOCK_MOVE_TARGETS, { error: msg("validation.moveTarget") }),
    technicianId: idField.optional().nullable(),
    note: optionalText(500),
  })
  .superRefine((m, ctx) => {
    if (m.to === "WITH_TECHNICIAN" && !m.technicianId) ctx.addIssue({ code: "custom", path: ["technicianId"], message: msg("validation.chooseTechnician") });
  });

export const cashReceiveSchema = z.object({
  technicianId: idField,
  /** Specific custody entries; all cash the technician holds when left out. */
  entryIds: z.array(idField).min(1).max(500).optional(),
});

export const confirmationSchema = z.object({
  confirmation: z.enum(CONFIRMATIONS as [string, ...string[]], { error: msg("validation.confirmation") }),
  version: z.number().int().positive().optional(),
});

export const cancelSchema = z.object({
  version: z.number().int().positive().optional(),
  reason: optionalText(1000),
});

export const availabilitySchema = z.object({
  date: z.string().refine(isValidDateString, msg("validation.date")),
  startTime: z.string().regex(TIME_RE, msg("validation.time")),
  durationMinutes: z.coerce.number().int().min(15).max(1440),
  excludeAppointmentId: idField.optional().nullable(),
});

const dateField = z.string({ error: msg("validation.date") }).refine(isValidDateString, msg("validation.date"));

/** Leave of a technician: whole company-local days, first and last day inclusive. */
export const leaveInputSchema = z
  .object({
    /** Admins add leave for a technician; a technician always asks for themselves. */
    userId: idField.optional().nullable(),
    startDate: dateField,
    endDate: dateField,
    type: z.enum(LEAVE_TYPES as [string, ...string[]], { error: msg("validation.leaveType") }),
    reason: optionalText(500),
  })
  .superRefine((v, ctx) => {
    if (!isValidDateString(v.startDate) || !isValidDateString(v.endDate)) return;
    if (v.endDate < v.startDate) ctx.addIssue({ code: "custom", path: ["endDate"], message: msg("validation.leaveEnd") });
    else if (Date.parse(v.endDate) - Date.parse(v.startDate) > 92 * 86_400_000) {
      ctx.addIssue({ code: "custom", path: ["endDate"], message: msg("validation.leaveMax") });
    }
  });

export const leaveDecisionSchema = z.object({
  decision: z.enum(["APPROVED", "REJECTED"], { error: msg("validation.decision") }),
  note: optionalText(500),
});

export const passwordSchema = z
  .string()
  .min(10, msg("validation.passwordMin"))
  .max(128, msg("validation.passwordMax"))
  .refine((v) => /[A-Za-z]/.test(v) && /\d/.test(v), msg("validation.passwordMix"));

export const loginSchema = z.object({
  email: z.preprocess((v) => (typeof v === "string" ? v.trim().toLowerCase() : v), z.string().min(1, msg("validation.emailRequired")).max(254)),
  password: z.string().min(1, msg("validation.passwordRequired")).max(128),
});

export const setPasswordSchema = z.object({
  token: z.string().min(20).max(200),
  password: passwordSchema,
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, msg("validation.currentPasswordRequired")).max(128),
  newPassword: passwordSchema,
});

const emailField = z.preprocess(
  (v) => (typeof v === "string" ? v.trim().toLowerCase() : v),
  z.email(msg("validation.email")).max(254),
);

const colorField = z.preprocess(
  (v) => (typeof v === "string" ? v.trim().toUpperCase() || null : (v ?? null)),
  z.string().regex(HEX_COLOR_RE, msg("validation.hexColor")).nullable(),
);

const viewerPermissionsField = z
  .array(z.enum(VIEWER_GRANTABLE as [string, ...string[]]))
  .refine((p) => new Set(p).size === p.length, msg("validation.duplicatePermission"));

export const userCreateSchema = z.object({
  name: requiredText("fields.fullName", 100),
  email: emailField,
  phone: optionalPhone,
  role: z.enum(ROLES as [string, ...string[]], { error: msg("validation.role") }),
  color: colorField.optional(),
  viewerPermissions: viewerPermissionsField.optional(),
  /** Optional: set an initial password directly instead of sending an invitation link. */
  password: z.preprocess((v) => (v === "" ? undefined : v), passwordSchema.optional()),
});

export const userUpdateSchema = z.object({
  name: requiredText("fields.fullName", 100).optional(),
  email: emailField.optional(),
  phone: optionalPhone.optional(),
  role: z.enum(ROLES as [string, ...string[]]).optional(),
  isActive: z.boolean().optional(),
  color: colorField.optional(),
  viewerPermissions: viewerPermissionsField.optional(),
});

export const statusInputSchema = z.object({
  name: requiredText("fields.name", 60),
  /** Arabic name shown to Arabic readers (optional; the name is used when blank). */
  nameAr: optionalText(60).optional(),
  kind: z.enum(STATUS_KINDS as [string, ...string[]]),
  color: z.string().regex(HEX_COLOR_RE, msg("validation.hexColor")),
  blocksSchedule: z.boolean(),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.coerce.number().int().min(0).max(1000).optional(),
});

export const settingsSchema = z
  .object({
    timezone: z.string().refine(isValidTimeZone, msg("validation.timezone")),
    weekStartsOn: z.coerce.number().int().min(0).max(6),
    dayStartHour: z.coerce.number().int().min(0).max(23),
    dayEndHour: z.coerce.number().int().min(1).max(24),
    defaultDurationMinutes: z.coerce.number().int().min(15).max(1440),
    travelBufferMinutes: z.coerce.number().int().min(0).max(240),
    salesCanViewReports: z.boolean(),
    salesCanEditOthersAppointments: z.boolean(),
    technicianCanSeeContacts: z.boolean(),
    /** Weekdays (0 = Sunday ... 6 = Saturday) on which no visits can be booked. */
    closedWeekdays: z
      .array(z.coerce.number().int().min(0).max(6))
      .max(6, msg("validation.oneDayOpen"))
      .refine((d) => new Set(d).size === d.length, msg("validation.dayTwice")),
    /** Used in messages to customers (WhatsApp reminders); blank = "your installation team". */
    companyName: z.preprocess((v) => (typeof v === "string" ? v.trim() : (v ?? "")), z.string().max(80, maxChars(80))),
    /** Technicians must tick the delivery checklist and add an after-photo, the customer's signature and (for transfers) the transfer proof before "Done". */
    requireDeliveryProof: z.boolean(),
    /** Installation visits need at least one installed serial number before "Done". */
    serialRequired: z.boolean(),
  })
  .refine((s) => s.dayEndHour > s.dayStartHour, { path: ["dayEndHour"], message: msg("validation.afterStartHour") });

export type SettingsValues = z.output<typeof settingsSchema>;

/** Flattens Zod issues into { "customer.phone": "message" } for forms. */
export function fieldErrorsFromZod(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_form";
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}
