import "server-only";
import {
  Prisma,
  type AppointmentStatus,
  type CustomerConfirmation,
  type EquipmentLocation,
  type InternetStatus,
  type PaymentMethod,
  type ProductCategory,
  type SiteReadiness,
  type StatusKind,
  type VisitType,
} from "@prisma/client";
import { z } from "zod";
import {
  PRODUCT_CATEGORIES,
  PRODUCT_CATEGORY_LABELS,
  appointmentCode,
  parseAppointmentCode,
  phoneDigits,
} from "@/lib/constants";
import { msg, ref, withNote, type Param } from "@/i18n/translate";
import { resolveLocationLink } from "@/lib/maps";
import { type Permission } from "@/lib/permissions";
import type { AppointmentDTO, AppointmentListItem, AuditEntryDTO } from "@/lib/types";
import { computeEnd, dateKey, dayRangeUtc, isValidDateString, todayKey, weekdayOfKey, zonedToUtc } from "@/lib/time";
import {
  appointmentInputSchema,
  cancelSchema,
  confirmationSchema,
  fieldErrorsFromZod,
  outcomeSchema,
  statusChangeSchema,
  type AppointmentInput,
} from "@/lib/validation";
import { prisma, type Tx } from "../db";
import { appointmentScope, assertCan, hasPermission } from "../access";
import type { CurrentUser } from "../auth/session";
import {
  ForbiddenError,
  NotFoundError,
  SchedulingConflictError,
  StaleRecordError,
  ValidationError,
} from "../errors";
import { diffValues, recordAudit } from "./audit";
import { notifyUsers, storedMessage } from "./notifications";
import { findTechnicianConflicts, isOverlapViolation, isUniqueViolation, lockTechnicians } from "./scheduling";
import { assertNotHeld, releaseHolds } from "./holds";
import { assertTechniciansNotOnLeave } from "./leaves";
import { canSeePrices, loadCustody, paymentDTO, prepareCollection, type CustodyView } from "./payments";
import { installSerials, installedOn } from "./stock";
import {
  appointmentFilterSql,
  appointmentListRows,
  appointmentOrderSql,
  countAppointments,
  escapeLike,
} from "./appointment-reads";
import { getSettings } from "./settings";

const userRefSelect = { id: true, name: true, color: true, isActive: true } as const;

export const appointmentInclude = {
  customer: true,
  location: true,
  status: true,
  createdBy: { select: userRefSelect },
  updatedBy: { select: { id: true, name: true } },
  technicians: {
    include: { technician: { select: userRefSelect } },
    orderBy: { technician: { name: "asc" } },
  },
} satisfies Prisma.AppointmentInclude;

type AppointmentFull = Prisma.AppointmentGetPayload<{ include: typeof appointmentInclude }>;

/** What the DTO needs: the appointment, its relations, the assigned technicians and linked visits. */
type AppointmentView = Omit<AppointmentFull, "technicians"> & {
  technicians: Pick<AppointmentFull["technicians"][number], "technician">[];
  links: Pick<AppointmentDTO, "followUpOf" | "followUps">;
  reportedBy: { id: string; name: string } | null;
  collectedBy: { id: string; name: string } | null;
  custody: CustodyView | null;
  installed: AppointmentDTO["installed"];
};

/** Statuses from which the outcome of a visit can be recorded (not cancelled or postponed). */
const REPORTABLE_KINDS: StatusKind[] = ["SCHEDULED", "IN_PROGRESS", "COMPLETED", "UNABLE_TO_COMPLETE", "NEEDS_REVISIT"];

function canReportVisit(user: CurrentUser, a: { createdById: string; technicians: { technician: { id: string } }[] }): boolean {
  if (hasPermission(user, "visits.report") && a.technicians.some((t) => t.technician.id === user.id)) return true;
  return canManageAppointment(user, a);
}

const TX_OPTIONS = { timeout: 20_000, maxWait: 10_000 };

// ---------------------------------------------------------------------------------------------
// Serialisation (with per-permission redaction)
// ---------------------------------------------------------------------------------------------

export function canManageAppointment(user: CurrentUser, appt: { createdById: string }): boolean {
  if (!hasPermission(user, "appointments.manage")) return false;
  if (user.role === "ADMIN") return true;
  return user.settings.salesCanEditOthersAppointments || appt.createdById === user.id;
}

function decimalToNumber(v: Prisma.Decimal | null): number | null {
  return v === null ? null : v.toNumber();
}

export function toAppointmentDTO(a: AppointmentView, user: CurrentUser): AppointmentDTO {
  const canContact = hasPermission(user, "customers.contact");
  const canLocation = hasPermission(user, "location.view");
  const canNotes = hasPermission(user, "notes.internal");
  const loc = a.location;
  return {
    id: a.id,
    number: a.number,
    code: appointmentCode(a.number),
    productCategory: a.productCategory,
    categoryOther: a.categoryOther,
    visitType: a.visitType,
    customerConfirmation: a.customerConfirmation,
    siteReadiness: a.siteReadiness,
    internetStatus: a.internetStatus,
    equipmentAt: a.equipmentAt,
    followUpOf: a.links.followUpOf,
    followUps: a.links.followUps,
    brand: a.brand,
    model: a.model,
    description: a.description,
    requiredEquipment: a.requiredEquipment,
    additionalNotes: a.additionalNotes,
    ...(canNotes ? { internalNotes: a.internalNotes } : {}),
    visitReport: a.visitReport,
    reportedAt: a.reportedAt?.toISOString() ?? null,
    reportedBy: a.reportedBy,
    startsAt: a.startsAt.toISOString(),
    endsAt: a.endsAt.toISOString(),
    durationMinutes: a.durationMinutes,
    status: {
      id: a.status.id,
      name: a.status.name,
      nameAr: a.status.nameAr,
      kind: a.status.kind,
      color: a.status.color,
      blocksSchedule: a.status.blocksSchedule,
    },
    createdBy: a.createdBy,
    updatedBy: a.updatedBy,
    technicians: a.technicians.map((t) => t.technician),
    customer: {
      id: a.customer.id,
      name: a.customer.name,
      ...(canContact ? { phone: a.customer.phone, secondaryPhone: a.customer.secondaryPhone } : {}),
    },
    location: canLocation
      ? {
          id: loc.id,
          area: loc.area,
          streetAddress: loc.streetAddress,
          building: loc.building,
          apartment: loc.apartment,
          floor: loc.floor,
          accessInstructions: loc.accessInstructions,
          mapUrl: loc.mapUrl,
          latitude: decimalToNumber(loc.latitude),
          longitude: decimalToNumber(loc.longitude),
          link: resolveLocationLink({
            mapUrl: loc.mapUrl,
            latitude: decimalToNumber(loc.latitude),
            longitude: decimalToNumber(loc.longitude),
          }),
        }
      : null,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
    version: a.version,
    canManage: canManageAppointment(user, a),
    canReport: canReportVisit(user, a),
    payment: paymentDTO(user, a, a.collectedBy, a.custody),
    installed: a.installed,
  };
}

// ---------------------------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------------------------

const csv = z.preprocess(
  (v) => (Array.isArray(v) ? v : typeof v === "string" && v ? v.split(",") : []),
  z.array(z.string().min(1).max(64)).max(20),
);

const optionalId = z.preprocess((v) => (v === "" ? undefined : v), z.string().min(1).max(64).optional());

export const appointmentFiltersSchema = z.object({
  q: z.preprocess((v) => (typeof v === "string" ? v.trim() : undefined), z.string().max(100).optional()),
  status: csv.optional(),
  category: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.enum(PRODUCT_CATEGORIES as [ProductCategory, ...ProductCategory[]]).optional(),
  ),
  salesId: optionalId,
  technicianId: optionalId,
  area: z.preprocess((v) => (typeof v === "string" ? v.trim() || undefined : undefined), z.string().max(120).optional()),
  from: z.preprocess((v) => (v === "" ? undefined : v), z.string().refine(isValidDateString).optional()),
  to: z.preprocess((v) => (v === "" ? undefined : v), z.string().refine(isValidDateString).optional()),
  sort: z.enum(["startsAt", "createdAt", "number", "customer"]).catch("startsAt"),
  dir: z.enum(["asc", "desc"]).catch("desc"),
  page: z.coerce.number().int().min(1).max(100_000).catch(1),
  pageSize: z.coerce.number().int().min(1).max(200).catch(25),
});

export type AppointmentFilters = z.output<typeof appointmentFiltersSchema>;

export function parseAppointmentFilters(params: URLSearchParams | Record<string, string | string[] | undefined>): AppointmentFilters {
  const obj: Record<string, unknown> =
    params instanceof URLSearchParams
      ? Object.fromEntries([...params.keys()].map((k) => [k, params.getAll(k).length > 1 ? params.getAll(k) : params.get(k)]))
      : params;
  const parsed = appointmentFiltersSchema.safeParse(obj);
  if (!parsed.success) throw new ValidationError(fieldErrorsFromZod(parsed.error), msg("e.invalidFilters"));
  return parsed.data;
}

function contains(value: string) {
  return { contains: escapeLike(value), mode: "insensitive" as const };
}

export function buildAppointmentWhere(user: CurrentUser, f: Partial<AppointmentFilters>): Prisma.AppointmentWhereInput {
  const and: Prisma.AppointmentWhereInput[] = [appointmentScope(user)];
  const tz = user.settings.timezone;

  if (f.q) {
    const or: Prisma.AppointmentWhereInput[] = [
      { customer: { name: contains(f.q) } },
      { brand: contains(f.q) },
      { model: contains(f.q) },
      { categoryOther: contains(f.q) },
    ];
    const num = parseAppointmentCode(f.q);
    if (num) or.push({ number: num });
    const digits = phoneDigits(f.q);
    // Never let users search by data they are not allowed to see.
    if (hasPermission(user, "customers.contact") && digits.length >= 3) {
      or.push({ customer: { phoneDigits: { contains: digits } } }, { customer: { secondaryPhoneDigits: { contains: digits } } });
    }
    if (hasPermission(user, "location.view")) {
      or.push(
        { location: { streetAddress: contains(f.q) } },
        { location: { area: contains(f.q) } },
        { location: { building: contains(f.q) } },
      );
    }
    and.push({ OR: or });
  }
  if (f.status?.length) and.push({ statusId: { in: f.status } });
  if (f.category) and.push({ productCategory: f.category });
  if (f.salesId) and.push({ createdById: f.salesId });
  if (f.technicianId) and.push({ technicians: { some: { technicianId: f.technicianId } } });
  if (f.area && hasPermission(user, "location.view")) {
    and.push({ OR: [{ location: { area: contains(f.area) } }, { location: { building: contains(f.area) } }] });
  }
  if (f.from || f.to) {
    const range = dayRangeUtc(f.from ?? "1970-01-01", f.to ?? "9999-12-30", tz);
    and.push({ startsAt: { gte: range.start, lt: range.end } });
  }
  return { AND: and };
}

export async function listAppointments(user: CurrentUser, f: AppointmentFilters) {
  assertCan(user, "appointments.view");
  const where = appointmentFilterSql(user, f);
  const [total, rows] = await Promise.all([
    countAppointments(where),
    appointmentListRows(user, where, appointmentOrderSql(f.sort, f.dir), f.pageSize, (f.page - 1) * f.pageSize, {
      orderedByCustomer: f.sort === "customer",
    }),
  ]);
  return {
    rows,
    total,
    page: f.page,
    pageSize: f.pageSize,
    pageCount: Math.max(1, Math.ceil(total / f.pageSize)),
  };
}

/** All appointments overlapping [from, to] (local dates) for the calendar views. */
export async function calendarAppointments(
  user: CurrentUser,
  range: { from: string; to: string },
  f: Partial<AppointmentFilters> = {},
): Promise<AppointmentListItem[]> {
  assertCan(user, "appointments.view");
  if (!isValidDateString(range.from) || !isValidDateString(range.to) || range.from > range.to) {
    throw new ValidationError({ from: msg("e.invalidDateRange") });
  }
  const { start, end } = dayRangeUtc(range.from, range.to, user.settings.timezone);
  if (end.getTime() - start.getTime() > 62 * 24 * 3600 * 1000) throw new ValidationError({ to: msg("e.rangeTooLarge") });
  const where = appointmentFilterSql(user, { ...f, from: undefined, to: undefined });
  // Appointments last at most 24 hours (validation + the appointments_duration_check constraint),
  // so anything overlapping the range starts after `start - 24h`. Stating that bound lets the
  // startsAt index serve the query even with a generic (parameter-blind) prepared-statement plan,
  // which otherwise walks every earlier appointment.
  const earliestStart = new Date(start.getTime() - 1440 * 60_000);
  return appointmentListRows(
    user,
    Prisma.sql`${where} AND a."startsAt" < ${end} AND a."startsAt" > ${earliestStart} AND a."endsAt" > ${start}`,
    Prisma.sql`a."startsAt" ASC, a.number ASC`,
    3000,
  );
}

/**
 * Loads an appointment with its relations in two round trips (the row, then its relations in
 * parallel) instead of one sequential query per relation.
 */
async function findVisibleAppointment(user: CurrentUser, id: string): Promise<AppointmentView> {
  assertCan(user, "appointments.view");
  if (typeof id !== "string" || id.length > 64) throw new NotFoundError(msg("e.appointmentNotFound"));
  // The scope is part of the query: a technician asking for someone else's appointment gets a
  // plain 404, exactly as if the ID did not exist.
  const appt = await prisma.appointment.findFirst({ where: { AND: [{ id }, appointmentScope(user)] } });
  if (!appt) throw new NotFoundError(msg("e.appointmentNotFound"));
  const scope = appointmentScope(user);
  const [customer, location, status, people, technicians, followUpOf, followUps, custody, installed] = await Promise.all([
    prisma.customer.findUniqueOrThrow({ where: { id: appt.customerId } }),
    prisma.customerLocation.findUniqueOrThrow({ where: { id: appt.locationId } }),
    prisma.appointmentStatus.findUniqueOrThrow({ where: { id: appt.statusId } }),
    prisma.user.findMany({
      where: { id: { in: [appt.createdById, appt.updatedById ?? appt.createdById, appt.reportedById ?? appt.createdById, appt.collectedById ?? appt.createdById] } },
      select: userRefSelect,
    }),
    prisma.user.findMany({
      where: { assignments: { some: { appointmentId: appt.id } } },
      select: userRefSelect,
      orderBy: { name: "asc" },
    }),
    appt.followUpOfId
      ? prisma.appointment.findFirst({ where: { AND: [{ id: appt.followUpOfId }, scope] }, select: { id: true, number: true } })
      : Promise.resolve(null),
    prisma.appointment.findMany({
      where: { AND: [{ followUpOfId: appt.id }, scope] },
      select: { id: true, number: true, startsAt: true, status: { select: { name: true, nameAr: true, color: true, kind: true } } },
      orderBy: { startsAt: "asc" },
      take: 20,
    }),
    canSeePrices(user) ? loadCustody(appt.id) : Promise.resolve(null),
    installedOn(appt.id),
  ]);
  const person = (pid: string) => people.find((p) => p.id === pid)!;
  return {
    ...appt,
    customer,
    location,
    status,
    createdBy: person(appt.createdById),
    updatedBy: appt.updatedById ? { id: appt.updatedById, name: person(appt.updatedById).name } : null,
    reportedBy: appt.reportedById ? { id: appt.reportedById, name: person(appt.reportedById).name } : null,
    collectedBy: appt.collectedById ? { id: appt.collectedById, name: person(appt.collectedById).name } : null,
    custody,
    installed,
    technicians: technicians.map((technician) => ({ technician })),
    links: {
      followUpOf: followUpOf ? { id: followUpOf.id, code: appointmentCode(followUpOf.number) } : null,
      followUps: followUps.map((f) => ({ id: f.id, code: appointmentCode(f.number), startsAt: f.startsAt.toISOString(), status: f.status })),
    },
  };
}

export async function getAppointment(user: CurrentUser, id: string): Promise<AppointmentDTO> {
  return toAppointmentDTO(await findVisibleAppointment(user, id), user);
}

/** Which permission is needed to see the old/new values of a field in the history. */
const FIELD_PERMISSIONS: Array<[RegExp, Permission]> = [
  [/^internalNotes$/, "notes.internal"],
  [/^customer\.(phone|secondaryPhone)$/, "customers.contact"],
  [/^location\./, "location.view"],
];
const MONEY_FIELD = /^(totalPrice|depositAmount|depositMethod|extraFee|collectedAmount|collectedMethod)$/;

export function redactChanges(user: CurrentUser, changes: unknown): AuditEntryDTO["changes"] {
  if (!changes || typeof changes !== "object") return null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(changes as Record<string, unknown>)) {
    const rule = FIELD_PERMISSIONS.find(([re]) => re.test(key));
    if ((rule && !hasPermission(user, rule[1])) || (MONEY_FIELD.test(key) && !canSeePrices(user))) {
      out[key] = { from: "(hidden)", to: "(hidden)" };
    } else {
      out[key] = value;
    }
  }
  return out as AuditEntryDTO["changes"];
}

export async function getAppointmentHistory(user: CurrentUser, id: string): Promise<AuditEntryDTO[]> {
  assertCan(user, "history.view");
  assertCan(user, "appointments.view");
  if (typeof id !== "string" || id.length > 64) throw new NotFoundError(msg("e.appointmentNotFound"));
  // Both queries run at once; the history is only returned if the appointment is visible.
  const [visible, rows] = await Promise.all([
    prisma.appointment.findFirst({ where: { AND: [{ id }, appointmentScope(user)] }, select: { id: true } }),
    prisma.auditLog.findMany({
      where: { appointmentId: id },
      include: { actor: { select: { id: true, name: true } } },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
  ]);
  if (!visible) throw new NotFoundError(msg("e.appointmentNotFound"));
  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    summary: r.summary,
    display: storedMessage(r.summary, r.params),
    changes: redactChanges(user, r.changes),
    actor: r.actor,
    createdAt: r.createdAt.toISOString(),
    entityType: r.entityType,
    entityId: r.entityId,
    appointmentId: r.appointmentId,
  }));
}

// ---------------------------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------------------------

function parseInput(raw: unknown): AppointmentInput {
  const parsed = appointmentInputSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(fieldErrorsFromZod(parsed.error));
  return parsed.data;
}

/** Ensures every id is an existing technician; inactive ones are only allowed if already assigned. */
async function validateTechnicians(tx: Tx, ids: string[], alreadyAssigned: string[]) {
  if (!ids.length) return [];
  const users = await tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, role: true, isActive: true } });
  for (const id of ids) {
    const u = users.find((x) => x.id === id);
    if (!u || u.role !== "TECHNICIAN") {
      throw new ValidationError({ technicianIds: msg("e.technicianMissing") });
    }
    if (!u.isActive && !alreadyAssigned.includes(id)) {
      throw new ValidationError({ technicianIds: msg("e.technicianInactive", { name: u.name }) });
    }
  }
  return users;
}

async function upsertCustomerAndLocation(tx: Tx, input: AppointmentInput) {
  const c = input.customer;
  const customerData = {
    name: c.name,
    phone: c.phone,
    phoneDigits: phoneDigits(c.phone),
    secondaryPhone: c.secondaryPhone,
    secondaryPhoneDigits: c.secondaryPhone ? phoneDigits(c.secondaryPhone) : null,
  };
  let customer;
  if (c.id) {
    const existing = await tx.customer.findUnique({ where: { id: c.id } });
    if (!existing) throw new ValidationError({ "customer.id": msg("e.customerGone") });
    customer = await tx.customer.update({ where: { id: c.id }, data: customerData });
  } else {
    customer = await tx.customer.create({ data: customerData });
  }

  const l = input.location;
  const locationData = {
    area: l.area,
    streetAddress: l.streetAddress,
    building: l.building,
    apartment: l.apartment,
    floor: l.floor,
    accessInstructions: l.accessInstructions,
    mapUrl: l.mapUrl,
    latitude: l.latitude === null ? null : new Prisma.Decimal(l.latitude.toFixed(6)),
    longitude: l.longitude === null ? null : new Prisma.Decimal(l.longitude.toFixed(6)),
  };
  let location;
  if (l.id) {
    const existing = await tx.customerLocation.findUnique({ where: { id: l.id } });
    if (!existing || existing.customerId !== customer.id) {
      throw new ValidationError({ "location.id": msg("e.locationNotCustomers") });
    }
    location = await tx.customerLocation.update({ where: { id: l.id }, data: locationData });
  } else {
    location = await tx.customerLocation.create({ data: { ...locationData, customerId: customer.id } });
  }
  return { customer, location };
}

/** Flat snapshot used for audit diffs. */
function snapshot(a: AppointmentFull | null) {
  if (!a) return {};
  return {
    "customer.name": a.customer.name,
    "customer.phone": a.customer.phone,
    "customer.secondaryPhone": a.customer.secondaryPhone,
    "location.area": a.location.area,
    "location.streetAddress": a.location.streetAddress,
    "location.building": a.location.building,
    "location.apartment": a.location.apartment,
    "location.floor": a.location.floor,
    "location.accessInstructions": a.location.accessInstructions,
    "location.mapUrl": a.location.mapUrl,
    "location.latitude": a.location.latitude,
    "location.longitude": a.location.longitude,
    productCategory: a.productCategory,
    categoryOther: a.categoryOther,
    visitType: a.visitType,
    customerConfirmation: a.customerConfirmation,
    siteReadiness: a.siteReadiness,
    internetStatus: a.internetStatus,
    equipmentAt: a.equipmentAt,
    brand: a.brand,
    model: a.model,
    description: a.description,
    requiredEquipment: a.requiredEquipment,
    additionalNotes: a.additionalNotes,
    internalNotes: a.internalNotes,
    totalPrice: a.totalPrice,
    depositAmount: a.depositAmount,
    depositMethod: a.depositMethod,
    extraFee: a.extraFee,
  };
}

type MoneyBefore = { totalPrice: Prisma.Decimal | null; depositAmount: Prisma.Decimal | null; depositMethod: PaymentMethod | null; extraFee: Prisma.Decimal | null };

/** Price fields to write; fields left out of an edit keep their value. */
function moneyData(input: AppointmentInput, before?: MoneyBefore) {
  const pick = (v: number | null | undefined, old: Prisma.Decimal | null | undefined) => (v === undefined ? (old?.toNumber() ?? null) : v);
  const totalPrice = pick(input.totalPrice, before?.totalPrice);
  const depositAmount = pick(input.depositAmount, before?.depositAmount) || null;
  const extraFee = pick(input.extraFee, before?.extraFee);
  const depositMethod = depositAmount ? ((input.depositMethod as PaymentMethod | null | undefined) ?? before?.depositMethod ?? null) : null;
  if (depositAmount && (totalPrice === null || depositAmount > totalPrice)) {
    const text = totalPrice === null ? msg("e.depositNeedsTotal") : msg("e.depositOverTotal");
    throw new ValidationError(totalPrice === null ? { totalPrice: text } : { depositAmount: text }, text);
  }
  if (depositAmount && !depositMethod) throw new ValidationError({ depositMethod: msg("e.chooseDepositMethod") });
  return { totalPrice, depositAmount, depositMethod, extraFee };
}

/** Closed weekdays (Settings) cannot be booked; only an Admin may book one, and only explicitly. */
function assertOpenDay(user: CurrentUser, date: string, closedWeekdays: number[], allowClosedDay: boolean | undefined) {
  const day = weekdayOfKey(date);
  if (!closedWeekdays.includes(day)) return;
  if (user.role === "ADMIN" && allowClosedDay) return;
  throw new ValidationError(
    { date: msg(user.role === "ADMIN" ? "e.closedDayAdmin" : "e.closedDay", { day: { weekday: day } }) },
    msg("e.closedDayShort"),
  );
}

/** Only an Admin may book on a day that has passed (to record a visit afterwards). */
function assertNotPast(user: CurrentUser, date: string, tz: string) {
  if (user.role !== "ADMIN" && date < todayKey(tz)) throw new ValidationError({ date: msg("e.pastBooking") });
}

/** "Sat 14 Mar 2026, 14:30–16:30" in the reader's language. */
function whenLabel(startsAt: Date, endsAt: Date, tz: string): Param {
  return { d: startsAt.toISOString(), e: endsAt.toISOString(), tz, s: "when" };
}

/** A status name as a translatable parameter. */
function statusName(s: { name: string; nameAr?: string | null }): Param {
  return { name: s.name, nameAr: s.nameAr ?? null };
}

async function loadFull(tx: Tx, id: string) {
  return tx.appointment.findUniqueOrThrow({ where: { id }, include: appointmentInclude });
}

async function resolveStatus(tx: Tx, statusId: string | null | undefined, current?: AppointmentStatus) {
  if (statusId) {
    if (current && current.id === statusId) return current;
    const s = await tx.appointmentStatus.findUnique({ where: { id: statusId } });
    if (!s || !s.isActive) throw new ValidationError({ statusId: msg("e.chooseStatus") });
    return s;
  }
  if (current) return current;
  const s =
    (await tx.appointmentStatus.findFirst({ where: { isDefault: true, isActive: true } })) ??
    (await tx.appointmentStatus.findFirst({ where: { kind: "SCHEDULED", isActive: true }, orderBy: { sortOrder: "asc" } }));
  if (!s) throw new ValidationError({ statusId: msg("e.noDefaultStatus") });
  return s;
}

async function conflictErrorFor(technicianIds: string[], startsAt: Date, endsAt: Date, excludeId: string | null, buffer: number) {
  const conflicts = await findTechnicianConflicts(prisma, {
    technicianIds,
    startsAt,
    endsAt,
    excludeAppointmentId: excludeId,
    bufferMinutes: buffer,
  });
  return new SchedulingConflictError(conflicts);
}

export async function createAppointment(user: CurrentUser, raw: unknown): Promise<AppointmentDTO> {
  assertCan(user, "appointments.manage");
  const input = parseInput(raw);
  const settings = await getSettings();
  const tz = settings.timezone;

  if (input.clientRequestId) {
    const existing = await prisma.appointment.findUnique({ where: { clientRequestId: input.clientRequestId }, select: { id: true } });
    if (existing) return getAppointment(user, existing.id);
  }

  // The original creator always comes from the session. Only an Admin may record a booking on
  // behalf of a Sales employee.
  let creatorId = user.id;
  if (input.salesUserId && input.salesUserId !== user.id) {
    if (user.role !== "ADMIN") throw new ForbiddenError(msg("e.onBehalfAdminOnly"));
    const sales = await prisma.user.findUnique({ where: { id: input.salesUserId } });
    if (!sales || !sales.isActive || (sales.role !== "SALES" && sales.role !== "ADMIN")) {
      throw new ValidationError({ salesUserId: msg("e.chooseSales") });
    }
    creatorId = sales.id;
  }

  const startsAt = zonedToUtc(input.date, input.startTime, tz);
  const endsAt = computeEnd(startsAt, input.durationMinutes);
  assertNotPast(user, input.date, tz);
  if (input.followUpOfId) {
    const original = await prisma.appointment.findFirst({ where: { AND: [{ id: input.followUpOfId }, appointmentScope(user)] }, select: { id: true } });
    if (!original) throw new ValidationError({ followUpOfId: msg("e.originalGone") });
  }

  try {
    const id = await prisma.$transaction(async (tx) => {
      if (input.clientRequestId) {
        // A double-click sends the same request twice at once: the second one waits here and then
        // returns the appointment the first one created instead of reporting a "conflict" with it.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`request:${input.clientRequestId}`}, 0))`;
        const existing = await tx.appointment.findUnique({ where: { clientRequestId: input.clientRequestId }, select: { id: true } });
        if (existing) return existing.id;
      }
      const status = await resolveStatus(tx, input.statusId);
      if (status.blocksSchedule) assertOpenDay(user, input.date, settings.closedWeekdays, input.allowClosedDay);
      await validateTechnicians(tx, input.technicianIds, []);
      await lockTechnicians(tx, input.technicianIds);
      if (status.blocksSchedule) {
        await assertNotHeld(tx, input.technicianIds, startsAt, endsAt, user.id, tz);
        await assertTechniciansNotOnLeave(tx, input.technicianIds, startsAt, endsAt, tz);
        const conflicts = await findTechnicianConflicts(tx, {
          technicianIds: input.technicianIds,
          startsAt,
          endsAt,
          bufferMinutes: settings.travelBufferMinutes,
        });
        if (conflicts.length) throw new SchedulingConflictError(conflicts);
      }
      const { customer, location } = await upsertCustomerAndLocation(tx, input);
      const appt = await tx.appointment.create({
        data: {
          customerId: customer.id,
          locationId: location.id,
          productCategory: input.productCategory as ProductCategory,
          categoryOther: input.productCategory === "OTHER" ? input.categoryOther : null,
          visitType: (input.visitType as VisitType | null | undefined) ?? null,
          customerConfirmation: (input.customerConfirmation as CustomerConfirmation | undefined) ?? "PENDING",
          siteReadiness: (input.siteReadiness as SiteReadiness | null | undefined) ?? null,
          internetStatus: (input.internetStatus as InternetStatus | null | undefined) ?? null,
          equipmentAt: (input.equipmentAt as EquipmentLocation | null | undefined) ?? null,
          followUpOfId: input.followUpOfId ?? null,
          ...moneyData(input),
          brand: input.brand,
          model: input.model,
          description: input.description,
          requiredEquipment: input.requiredEquipment,
          additionalNotes: input.additionalNotes,
          internalNotes: hasPermission(user, "notes.internal") ? input.internalNotes : null,
          startsAt,
          endsAt,
          durationMinutes: input.durationMinutes,
          statusId: status.id,
          createdById: creatorId,
          updatedById: user.id,
          clientRequestId: input.clientRequestId ?? null,
        },
      });
      if (input.technicianIds.length) {
        await tx.appointmentTechnician.createMany({
          data: input.technicianIds.map((technicianId) => ({
            appointmentId: appt.id,
            technicianId,
            startsAt,
            endsAt,
            blocksSchedule: status.blocksSchedule,
            assignedById: user.id,
          })),
        });
      }
      const full = await loadFull(tx, appt.id);
      const code = appointmentCode(full.number);
      await recordAudit(tx, {
        entityType: "APPOINTMENT",
        entityId: appt.id,
        appointmentId: appt.id,
        action: "APPOINTMENT_CREATED",
        summary: msg("s.apptCreated", { code, customer: customer.name, when: whenLabel(startsAt, endsAt, tz) }),
        changes: {
          ...snapshot(full),
          startsAt: startsAt.toISOString(),
          endsAt: endsAt.toISOString(),
          durationMinutes: input.durationMinutes,
          status: status.name,
          technicians: full.technicians.map((t) => t.technician.name),
          createdBy: full.createdBy.name,
        },
        actorId: user.id,
      });
      await notifyUsers(
        tx,
        input.technicianIds,
        {
          appointmentId: appt.id,
          type: "ASSIGNED",
          message: msg("n.assigned", { code, customer: customer.name, when: whenLabel(startsAt, endsAt, tz) }),
        },
        user.id,
      );
      // The slot is booked now; whatever this user was holding is no longer needed.
      await releaseHolds(tx, user.id);
      return appt.id;
    }, TX_OPTIONS);
    return getAppointment(user, id);
  } catch (e) {
    if (isOverlapViolation(e)) {
      throw await conflictErrorFor(input.technicianIds, startsAt, endsAt, null, settings.travelBufferMinutes);
    }
    if (input.clientRequestId && isUniqueViolation(e, "clientRequestId")) {
      const existing = await prisma.appointment.findUnique({ where: { clientRequestId: input.clientRequestId }, select: { id: true } });
      if (existing) return getAppointment(user, existing.id);
    }
    throw e;
  }
}

async function lockAppointmentRow(tx: Tx, id: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM appointments WHERE id = ${id} FOR UPDATE`;
  if (!rows.length) throw new NotFoundError(msg("e.appointmentNotFound"));
}

/** Loads an appointment for modification, enforcing visibility, edit rights and optimistic locking. */
async function loadForUpdate(tx: Tx, user: CurrentUser, id: string, version?: number) {
  if (typeof id !== "string" || id.length > 64) throw new NotFoundError(msg("e.appointmentNotFound"));
  await lockAppointmentRow(tx, id);
  const visible = await tx.appointment.findFirst({ where: { AND: [{ id }, appointmentScope(user)] }, select: { id: true } });
  if (!visible) throw new NotFoundError(msg("e.appointmentNotFound"));
  const existing = await loadFull(tx, id);
  if (!canManageAppointment(user, existing)) {
    throw new ForbiddenError(msg("e.onlyOwnAppointments"));
  }
  if (version !== undefined && version !== existing.version) throw new StaleRecordError();
  return existing;
}

export async function updateAppointment(user: CurrentUser, id: string, raw: unknown): Promise<AppointmentDTO> {
  assertCan(user, "appointments.manage");
  const input = parseInput(raw);
  const settings = await getSettings();
  const tz = settings.timezone;
  const startsAt = zonedToUtc(input.date, input.startTime, tz);
  const endsAt = computeEnd(startsAt, input.durationMinutes);

  try {
    await prisma.$transaction(async (tx) => {
      const existing = await loadForUpdate(tx, user, id, input.version);
      const status = await resolveStatus(tx, input.statusId, existing.status);
      // Moving a booking onto a past day follows the same rule as creating one there.
      if (dateKey(existing.startsAt, tz) !== input.date) assertNotPast(user, input.date, tz);
      if (status.blocksSchedule && dateKey(existing.startsAt, tz) !== input.date) {
        assertOpenDay(user, input.date, settings.closedWeekdays, input.allowClosedDay);
      }
      const currentTechIds = existing.technicians.map((t) => t.technicianId);
      await validateTechnicians(tx, input.technicianIds, currentTechIds);
      await lockTechnicians(tx, [...currentTechIds, ...input.technicianIds]);
      if (status.blocksSchedule) {
        // Like closed days: technicians already on the booking are only re-checked when it moves to
        // other days (or is re-activated), so a booking made before the leave can still be edited.
        const daysChanged = dateKey(existing.startsAt, tz) !== dateKey(startsAt, tz) || dateKey(existing.endsAt, tz) !== dateKey(endsAt, tz);
        const recheck = daysChanged || !existing.status.blocksSchedule;
        const onLeaveCheck = recheck ? input.technicianIds : input.technicianIds.filter((t) => !currentTechIds.includes(t));
        await assertTechniciansNotOnLeave(tx, onLeaveCheck, startsAt, endsAt, tz);
        await assertNotHeld(tx, input.technicianIds, startsAt, endsAt, user.id, tz);
        const conflicts = await findTechnicianConflicts(tx, {
          technicianIds: input.technicianIds,
          startsAt,
          endsAt,
          excludeAppointmentId: id,
          bufferMinutes: settings.travelBufferMinutes,
        });
        if (conflicts.length) throw new SchedulingConflictError(conflicts);
      }

      const { customer, location } = await upsertCustomerAndLocation(tx, input);
      await tx.appointment.update({
        where: { id, version: existing.version },
        data: {
          customerId: customer.id,
          locationId: location.id,
          productCategory: input.productCategory as ProductCategory,
          categoryOther: input.productCategory === "OTHER" ? input.categoryOther : null,
          visitType: input.visitType === undefined ? existing.visitType : ((input.visitType as VisitType | null) ?? null),
          customerConfirmation: (input.customerConfirmation as CustomerConfirmation | undefined) ?? existing.customerConfirmation,
          siteReadiness: input.siteReadiness === undefined ? existing.siteReadiness : ((input.siteReadiness as SiteReadiness | null) ?? null),
          internetStatus: input.internetStatus === undefined ? existing.internetStatus : ((input.internetStatus as InternetStatus | null) ?? null),
          equipmentAt: input.equipmentAt === undefined ? existing.equipmentAt : ((input.equipmentAt as EquipmentLocation | null) ?? null),
          // followUpOfId is set at creation only.
          ...moneyData(input, existing),
          brand: input.brand,
          model: input.model,
          description: input.description,
          requiredEquipment: input.requiredEquipment,
          additionalNotes: input.additionalNotes,
          // Never overwrite notes the editor is not allowed to see.
          internalNotes: hasPermission(user, "notes.internal") ? input.internalNotes : existing.internalNotes,
          startsAt,
          endsAt,
          durationMinutes: input.durationMinutes,
          statusId: status.id,
          updatedById: user.id,
          version: { increment: 1 },
          // createdById is deliberately never updated: the original Sales creator is permanent.
        },
      });

      const removed = currentTechIds.filter((t) => !input.technicianIds.includes(t));
      const added = input.technicianIds.filter((t) => !currentTechIds.includes(t));
      const kept = input.technicianIds.filter((t) => currentTechIds.includes(t));
      if (removed.length) {
        await tx.appointmentTechnician.deleteMany({ where: { appointmentId: id, technicianId: { in: removed } } });
      }
      if (kept.length) {
        await tx.appointmentTechnician.updateMany({
          where: { appointmentId: id, technicianId: { in: kept } },
          data: { startsAt, endsAt, blocksSchedule: status.blocksSchedule },
        });
      }
      if (added.length) {
        await tx.appointmentTechnician.createMany({
          data: added.map((technicianId) => ({
            appointmentId: id,
            technicianId,
            startsAt,
            endsAt,
            blocksSchedule: status.blocksSchedule,
            assignedById: user.id,
          })),
        });
      }

      const after = await loadFull(tx, id);
      const code = appointmentCode(after.number);
      const audits: Parameters<typeof recordAudit>[1][] = [];

      const detailChanges = diffValues(snapshot(existing), snapshot(after));
      if (Object.keys(detailChanges).length) {
        audits.push({
          entityType: "APPOINTMENT",
          entityId: id,
          appointmentId: id,
          action: "APPOINTMENT_UPDATED",
          summary: msg("s.apptUpdated", { code }),
          changes: detailChanges,
          actorId: user.id,
        });
      }
      const timeChanged =
        existing.startsAt.getTime() !== startsAt.getTime() || existing.endsAt.getTime() !== endsAt.getTime();
      if (timeChanged) {
        audits.push({
          entityType: "APPOINTMENT",
          entityId: id,
          appointmentId: id,
          action: "APPOINTMENT_RESCHEDULED",
          summary: msg("s.apptRescheduled", { code, from: whenLabel(existing.startsAt, existing.endsAt, tz), to: whenLabel(startsAt, endsAt, tz) }),
          changes: diffValues(
            { startsAt: existing.startsAt, endsAt: existing.endsAt, durationMinutes: existing.durationMinutes },
            { startsAt, endsAt, durationMinutes: input.durationMinutes },
          ),
          actorId: user.id,
        });
      }
      if (removed.length || added.length) {
        const beforeNames = existing.technicians.map((t) => t.technician.name);
        const afterNames = after.technicians.map((t) => t.technician.name);
        audits.push({
          entityType: "APPOINTMENT",
          entityId: id,
          appointmentId: id,
          action: "TECHNICIANS_CHANGED",
          summary: msg("s.techniciansChanged", { code, names: afterNames.length ? { join: afterNames } : ref("s.none") }),
          changes: { technicians: { from: beforeNames, to: afterNames } },
          actorId: user.id,
        });
      }
      if (existing.statusId !== status.id) {
        audits.push({
          entityType: "APPOINTMENT",
          entityId: id,
          appointmentId: id,
          action: status.kind === "CANCELLED" ? "APPOINTMENT_CANCELLED" : "STATUS_CHANGED",
          summary: msg("s.statusChanged", { code, from: statusName(existing.status), to: statusName(status) }),
          changes: { status: { from: existing.status.name, to: status.name } },
          actorId: user.id,
        });
      }
      for (const a of audits) await recordAudit(tx, a);
      await releaseHolds(tx, user.id);

      const when = whenLabel(startsAt, endsAt, tz);
      await notifyUsers(tx, added, { appointmentId: id, type: "ASSIGNED", message: msg("n.assigned", { code, customer: customer.name, when }) }, user.id);
      await notifyUsers(tx, removed, { appointmentId: id, type: "UNASSIGNED", message: msg("n.unassigned", { code, customer: customer.name }) }, user.id);
      if (audits.length) {
        await notifyUsers(
          tx,
          kept,
          {
            appointmentId: id,
            type: timeChanged ? "RESCHEDULED" : "UPDATED",
            message: timeChanged ? msg("n.rescheduled", { code, when }) : msg("n.updated", { code, customer: customer.name }),
          },
          user.id,
        );
      }
    }, TX_OPTIONS);
  } catch (e) {
    if (isOverlapViolation(e)) {
      throw await conflictErrorFor(input.technicianIds, startsAt, endsAt, id, settings.travelBufferMinutes);
    }
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") throw new StaleRecordError();
    throw e;
  }
  return getAppointment(user, id);
}

async function applyStatusChange(
  user: CurrentUser,
  id: string,
  statusIdOrKind: { statusId: string } | { kind: "CANCELLED" },
  version: number | undefined,
  note: string | null,
): Promise<AppointmentDTO> {
  assertCan(user, "appointments.manage");
  const settings = await getSettings();
  const tz = settings.timezone;
  // Filled inside the transaction; used to explain an overlap violation afterwards.
  const ctx: { techIds: string[]; startsAt?: Date; endsAt?: Date } = { techIds: [] };
  try {
    await prisma.$transaction(async (tx) => {
      const existing = await loadForUpdate(tx, user, id, version);
      const techIds = existing.technicians.map((t) => t.technicianId);
      Object.assign(ctx, { techIds, startsAt: existing.startsAt, endsAt: existing.endsAt });
      const status =
        "statusId" in statusIdOrKind
          ? await resolveStatus(tx, statusIdOrKind.statusId, existing.status)
          : await tx.appointmentStatus.findFirst({ where: { kind: "CANCELLED", isActive: true }, orderBy: { sortOrder: "asc" } });
      if (!status) throw new ValidationError({ statusId: msg("e.noCancelStatus") });
      if (status.id === existing.statusId) return;

      // Re-activating (e.g. un-cancelling) must not create a double booking.
      if (status.blocksSchedule && !existing.status.blocksSchedule && techIds.length) {
        await lockTechnicians(tx, techIds);
        await assertTechniciansNotOnLeave(tx, techIds, existing.startsAt, existing.endsAt, tz);
        const conflicts = await findTechnicianConflicts(tx, {
          technicianIds: techIds,
          startsAt: existing.startsAt,
          endsAt: existing.endsAt,
          excludeAppointmentId: id,
          bufferMinutes: settings.travelBufferMinutes,
        });
        if (conflicts.length) throw new SchedulingConflictError(conflicts);
      }
      await tx.appointment.update({
        where: { id, version: existing.version },
        data: { statusId: status.id, updatedById: user.id, version: { increment: 1 } },
      });
      await tx.appointmentTechnician.updateMany({ where: { appointmentId: id }, data: { blocksSchedule: status.blocksSchedule } });
      const code = appointmentCode(existing.number);
      const cancelled = status.kind === "CANCELLED";
      await recordAudit(tx, {
        entityType: "APPOINTMENT",
        entityId: id,
        appointmentId: id,
        action: cancelled ? "APPOINTMENT_CANCELLED" : "STATUS_CHANGED",
        summary: cancelled
          ? withNote(msg("s.apptCancelled", { code }), note)
          : msg("s.statusChanged", { code, from: statusName(existing.status), to: statusName(status) }),
        changes: { status: { from: existing.status.name, to: status.name }, ...(note ? { note } : {}) },
        actorId: user.id,
      });
      await notifyUsers(
        tx,
        techIds,
        {
          appointmentId: id,
          type: cancelled ? "CANCELLED" : "STATUS_CHANGED",
          message: cancelled
            ? msg("n.cancelled", { code, customer: existing.customer.name, when: whenLabel(existing.startsAt, existing.endsAt, tz) })
            : msg("n.statusChanged", { code, status: statusName(status) }),
        },
        user.id,
      );
    }, TX_OPTIONS);
  } catch (e) {
    if (isOverlapViolation(e) && ctx.startsAt && ctx.endsAt) {
      throw await conflictErrorFor(ctx.techIds, ctx.startsAt, ctx.endsAt, id, settings.travelBufferMinutes);
    }
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") throw new StaleRecordError();
    throw e;
  }
  return getAppointment(user, id);
}

export async function changeAppointmentStatus(user: CurrentUser, id: string, raw: unknown) {
  const parsed = statusChangeSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(fieldErrorsFromZod(parsed.error));
  return applyStatusChange(user, id, { statusId: parsed.data.statusId }, parsed.data.version, parsed.data.note);
}

export async function cancelAppointment(user: CurrentUser, id: string, raw: unknown) {
  const parsed = cancelSchema.safeParse(raw ?? {});
  if (!parsed.success) throw new ValidationError(fieldErrorsFromZod(parsed.error));
  return applyStatusChange(user, id, { kind: "CANCELLED" }, parsed.data.version, parsed.data.reason);
}

/**
 * The assigned technician (or a manager) records how the visit went: started, done, unable to
 * complete or needs another visit, with a report for every outcome except "started".
 */
export async function recordVisitOutcome(user: CurrentUser, id: string, raw: unknown): Promise<AppointmentDTO> {
  if (!hasPermission(user, "visits.report") && !hasPermission(user, "appointments.manage")) throw new ForbiddenError();
  const parsed = outcomeSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(fieldErrorsFromZod(parsed.error));
  const input = parsed.data;
  if (typeof id !== "string" || id.length > 64) throw new NotFoundError(msg("e.appointmentNotFound"));
  const settings = await getSettings();
  const ctx: { techIds: string[]; startsAt?: Date; endsAt?: Date } = { techIds: [] };
  try {
    await prisma.$transaction(async (tx) => {
      await lockAppointmentRow(tx, id);
      const visible = await tx.appointment.findFirst({ where: { AND: [{ id }, appointmentScope(user)] }, select: { id: true } });
      if (!visible) throw new NotFoundError(msg("e.appointmentNotFound"));
      const existing = await loadFull(tx, id);
      if (!canReportVisit(user, existing)) throw new ForbiddenError(msg("e.onlyAssignedReport"));
      if (input.version !== undefined && input.version !== existing.version) throw new StaleRecordError();
      if (!REPORTABLE_KINDS.includes(existing.status.kind)) {
        const text = msg("e.noOutcomeInStatus", { status: statusName(existing.status) });
        throw new ValidationError({ outcome: text }, text);
      }
      const status = await tx.appointmentStatus.findFirst({ where: { kind: input.outcome, isActive: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
      if (!status) {
        const text = msg("e.noStatusOfKind", { kind: ref(`enum.statusKind.${input.outcome}`) });
        throw new ValidationError({ outcome: text }, text);
      }
      const report = input.report ?? existing.visitReport;
      const now = new Date();
      const collection = await prepareCollection(tx, user, existing, input.collectedAmount, input.collectedMethod, now);
      const installed = await installSerials(tx, user, existing, input.serials ?? [], settings.timezone, now);
      if (status.id === existing.statusId && report === existing.visitReport && !collection && !installed.length) return;
      const techIds = existing.technicians.map((t) => t.technicianId);
      Object.assign(ctx, { techIds, startsAt: existing.startsAt, endsAt: existing.endsAt });
      if (status.blocksSchedule && !existing.status.blocksSchedule && techIds.length) {
        await lockTechnicians(tx, techIds);
        const conflicts = await findTechnicianConflicts(tx, {
          technicianIds: techIds,
          startsAt: existing.startsAt,
          endsAt: existing.endsAt,
          excludeAppointmentId: id,
          bufferMinutes: settings.travelBufferMinutes,
        });
        if (conflicts.length) throw new SchedulingConflictError(conflicts);
      }
      const reportChanged = report !== existing.visitReport;
      await tx.appointment.update({
        where: { id, version: existing.version },
        data: {
          statusId: status.id,
          visitReport: report,
          ...(reportChanged ? { reportedAt: now, reportedById: user.id } : {}),
          ...(collection?.data ?? {}),
          updatedById: user.id,
          version: { increment: 1 },
        },
      });
      await collection?.syncCustody();
      if (status.blocksSchedule !== existing.status.blocksSchedule) {
        await tx.appointmentTechnician.updateMany({ where: { appointmentId: id }, data: { blocksSchedule: status.blocksSchedule } });
      }
      const code = appointmentCode(existing.number);
      await recordAudit(tx, {
        entityType: "APPOINTMENT",
        entityId: id,
        appointmentId: id,
        action: "VISIT_OUTCOME",
        // Amounts stay out of the summary: it is shown unredacted, the changes are redacted per field.
        summary: withNote(msg("s.visitOutcome", { user: user.name, status: statusName(status), code }), report),
        changes: {
          ...(status.id !== existing.statusId ? { status: { from: existing.status.name, to: status.name } } : {}),
          ...(reportChanged ? { visitReport: { from: existing.visitReport, to: report } } : {}),
          ...(collection?.changes ?? {}),
          ...(installed.length ? { installedSerials: { from: null, to: installed } } : {}),
        },
        actorId: user.id,
      });
      // The Sales creator and any other technician on the job hear about it.
      await notifyUsers(
        tx,
        [existing.createdById, ...techIds],
        {
          appointmentId: id,
          type: "VISIT_OUTCOME",
          message: msg("s.parts", {
            parts: {
              join: [
                ref("n.visitOutcome", { user: user.name, code, customer: existing.customer.name, status: statusName(status) }),
                collection?.summary ?? null,
                installed.length ? ref("s.installedItems", { items: ref("common.itemsCount", { count: installed.length }) }) : null,
              ],
            },
          }),
        },
        user.id,
      );
    }, TX_OPTIONS);
  } catch (e) {
    if (isOverlapViolation(e) && ctx.startsAt && ctx.endsAt) {
      throw await conflictErrorFor(ctx.techIds, ctx.startsAt, ctx.endsAt, id, settings.travelBufferMinutes);
    }
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") throw new StaleRecordError();
    throw e;
  }
  return getAppointment(user, id);
}

/** Records whether the customer confirmed the booked time (quick action on the details page). */
export async function setCustomerConfirmation(user: CurrentUser, id: string, raw: unknown): Promise<AppointmentDTO> {
  assertCan(user, "appointments.manage");
  const parsed = confirmationSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(fieldErrorsFromZod(parsed.error));
  const next = parsed.data.confirmation as CustomerConfirmation;
  try {
    await prisma.$transaction(async (tx) => {
      const existing = await loadForUpdate(tx, user, id, parsed.data.version);
      if (existing.customerConfirmation === next) return;
      await tx.appointment.update({
        where: { id, version: existing.version },
        data: { customerConfirmation: next, updatedById: user.id, version: { increment: 1 } },
      });
      await recordAudit(tx, {
        entityType: "APPOINTMENT",
        entityId: id,
        appointmentId: id,
        action: "CONFIRMATION_CHANGED",
        summary: msg("s.confirmation", { code: appointmentCode(existing.number), value: ref(`enum.confirmation.${next}`) }),
        changes: { customerConfirmation: { from: existing.customerConfirmation, to: next } },
        actorId: user.id,
      });
    }, TX_OPTIONS);
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") throw new StaleRecordError();
    throw e;
  }
  return getAppointment(user, id);
}

export function categoryLabel(a: { productCategory: ProductCategory; categoryOther: string | null }) {
  return a.productCategory === "OTHER" && a.categoryOther ? a.categoryOther : PRODUCT_CATEGORY_LABELS[a.productCategory];
}
