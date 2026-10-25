/**
 * Zod schemas shared by the browser (instant feedback) and the API (authoritative validation).
 */
import { z } from "zod";
import { HEX_COLOR_RE } from "./colors";
import { CONFIRMATIONS, PRODUCT_CATEGORIES, ROLES, STATUS_KINDS, VISIT_TYPES, phoneDigits } from "./constants";
import { checkMapUrl, isValidLatitude, isValidLongitude } from "./maps";
import { VIEWER_GRANTABLE } from "./permissions";
import { TIME_RE, isValidDateString, isValidTimeZone } from "./time";

/** Optional free text: trims, turns "" into null, enforces a max length. */
export const optionalText = (max: number) =>
  z.preprocess(
    (v) => (typeof v === "string" ? v.trim() || null : (v ?? null)),
    z.string().max(max, `Must be at most ${max} characters`).nullable(),
  );

const requiredText = (label: string, max: number) =>
  z.preprocess(
    (v) => (typeof v === "string" ? v.trim() : v),
    z.string({ error: `${label} is required` }).min(1, `${label} is required`).max(max, `Must be at most ${max} characters`),
  );

const phoneField = (label: string) =>
  requiredText(label, 30)
    .refine((v) => /^[+\d\s().-]+$/.test(v), "Use digits, spaces, +, -, ( ) only")
    .refine((v) => {
      const n = phoneDigits(v).length;
      return n >= 7 && n <= 15;
    }, "Enter a valid phone number (7-15 digits)");

const optionalPhone = z.preprocess(
  (v) => (typeof v === "string" ? v.trim() || null : (v ?? null)),
  z
    .string()
    .max(30)
    .refine((v) => /^[+\d\s().-]+$/.test(v), "Use digits, spaces, +, -, ( ) only")
    .refine((v) => {
      const n = phoneDigits(v).length;
      return n >= 7 && n <= 15;
    }, "Enter a valid phone number (7-15 digits)")
    .nullable(),
);

const optionalNumber = z.preprocess((v) => {
  if (v === "" || v === null || v === undefined) return null;
  return typeof v === "string" ? Number(v.trim()) : v;
}, z.number({ error: "Must be a number" }).nullable());

const idField = z.string().min(1).max(64);

export const customerInputSchema = z.object({
  id: idField.optional().nullable(),
  name: requiredText("Customer name", 120),
  phone: phoneField("Primary phone number"),
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
      message: "Enter a valid map link starting with https://",
    }),
    latitude: optionalNumber.refine((v) => v === null || isValidLatitude(v), "Latitude must be between -90 and 90"),
    longitude: optionalNumber.refine((v) => v === null || isValidLongitude(v), "Longitude must be between -180 and 180"),
  })
  .superRefine((loc, ctx) => {
    if ((loc.latitude === null) !== (loc.longitude === null)) {
      ctx.addIssue({
        code: "custom",
        path: [loc.latitude === null ? "latitude" : "longitude"],
        message: "Enter both latitude and longitude, or neither",
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
    productCategory: z.enum(PRODUCT_CATEGORIES as [string, ...string[]], { error: "Choose a product category" }),
    visitType: z.preprocess((v) => (v === "" ? null : v), z.enum(VISIT_TYPES as [string, ...string[]], { error: "Choose a visit type" }).nullable().optional()),
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
    date: z.string({ error: "Date is required" }).refine(isValidDateString, "Enter a valid date"),
    startTime: z.string({ error: "Start time is required" }).regex(TIME_RE, "Enter a valid time (HH:MM)"),
    durationMinutes: z.coerce
      .number({ error: "Duration is required" })
      .int("Duration must be whole minutes")
      .min(15, "Minimum duration is 15 minutes")
      .max(1440, "Maximum duration is 24 hours"),
    technicianIds: z
      .array(idField)
      .max(10, "At most 10 technicians per appointment")
      .refine((ids) => new Set(ids).size === ids.length, "A technician was selected twice"),
    statusId: idField.optional().nullable(),
  })
  .superRefine((a, ctx) => {
    if (a.productCategory === "OTHER" && !a.categoryOther) {
      ctx.addIssue({ code: "custom", path: ["categoryOther"], message: "Describe the product category" });
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
    outcome: z.enum(VISIT_OUTCOMES, { error: "Choose the outcome of the visit" }),
    report: optionalText(4000),
    version: z.number().int().positive().optional(),
  })
  .superRefine((o, ctx) => {
    if (o.outcome !== "IN_PROGRESS" && !o.report) {
      ctx.addIssue({ code: "custom", path: ["report"], message: "Write what was done (or why not) - the visit report is required" });
    }
  });

export const confirmationSchema = z.object({
  confirmation: z.enum(CONFIRMATIONS as [string, ...string[]], { error: "Choose a confirmation status" }),
  version: z.number().int().positive().optional(),
});

export const cancelSchema = z.object({
  version: z.number().int().positive().optional(),
  reason: optionalText(1000),
});

export const availabilitySchema = z.object({
  date: z.string().refine(isValidDateString, "Enter a valid date"),
  startTime: z.string().regex(TIME_RE, "Enter a valid time"),
  durationMinutes: z.coerce.number().int().min(15).max(1440),
  excludeAppointmentId: idField.optional().nullable(),
});

export const passwordSchema = z
  .string()
  .min(10, "Password must be at least 10 characters")
  .max(128, "Password must be at most 128 characters")
  .refine((v) => /[A-Za-z]/.test(v) && /\d/.test(v), "Password must contain letters and numbers");

export const loginSchema = z.object({
  email: z.preprocess((v) => (typeof v === "string" ? v.trim().toLowerCase() : v), z.string().min(1, "Email is required").max(254)),
  password: z.string().min(1, "Password is required").max(128),
});

export const setPasswordSchema = z.object({
  token: z.string().min(20).max(200),
  password: passwordSchema,
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Current password is required").max(128),
  newPassword: passwordSchema,
});

const emailField = z.preprocess(
  (v) => (typeof v === "string" ? v.trim().toLowerCase() : v),
  z.email("Enter a valid email address").max(254),
);

const colorField = z.preprocess(
  (v) => (typeof v === "string" ? v.trim().toUpperCase() || null : (v ?? null)),
  z.string().regex(HEX_COLOR_RE, "Use a hex colour like #E55823").nullable(),
);

const viewerPermissionsField = z
  .array(z.enum(VIEWER_GRANTABLE as [string, ...string[]]))
  .refine((p) => new Set(p).size === p.length, "Duplicate permission");

export const userCreateSchema = z.object({
  name: requiredText("Full name", 100),
  email: emailField,
  phone: optionalPhone,
  role: z.enum(ROLES as [string, ...string[]], { error: "Choose a role" }),
  color: colorField.optional(),
  viewerPermissions: viewerPermissionsField.optional(),
  /** Optional: set an initial password directly instead of sending an invitation link. */
  password: z.preprocess((v) => (v === "" ? undefined : v), passwordSchema.optional()),
});

export const userUpdateSchema = z.object({
  name: requiredText("Full name", 100).optional(),
  email: emailField.optional(),
  phone: optionalPhone.optional(),
  role: z.enum(ROLES as [string, ...string[]]).optional(),
  isActive: z.boolean().optional(),
  color: colorField.optional(),
  viewerPermissions: viewerPermissionsField.optional(),
});

export const statusInputSchema = z.object({
  name: requiredText("Name", 60),
  kind: z.enum(STATUS_KINDS as [string, ...string[]]),
  color: z.string().regex(HEX_COLOR_RE, "Use a hex colour like #E55823"),
  blocksSchedule: z.boolean(),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.coerce.number().int().min(0).max(1000).optional(),
});

export const settingsSchema = z
  .object({
    timezone: z.string().refine(isValidTimeZone, "Unknown timezone"),
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
      .max(6, "At least one day must stay open")
      .refine((d) => new Set(d).size === d.length, "A day was selected twice"),
  })
  .refine((s) => s.dayEndHour > s.dayStartHour, { path: ["dayEndHour"], message: "Must be after the start hour" });

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
