import "server-only";
import { Prisma, type AppointmentStatus, type ProductCategory } from "@prisma/client";
import { z } from "zod";
import { PRODUCT_CATEGORIES, PRODUCT_CATEGORY_LABELS, appointmentCode, parseAppointmentCode, phoneDigits } from "@/lib/constants";
import { resolveLocationLink } from "@/lib/maps";
import { type Permission } from "@/lib/permissions";
import type { AppointmentDTO, AppointmentListItem, AuditEntryDTO } from "@/lib/types";
import { computeEnd, dayRangeUtc, fmt, isValidDateString, zonedToUtc } from "@/lib/time";
import {
  appointmentInputSchema,
  cancelSchema,
  fieldErrorsFromZod,
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
import { notifyUsers } from "./notifications";
import { findTechnicianConflicts, isOverlapViolation, isUniqueViolation, lockTechnicians } from "./scheduling";
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

export function toAppointmentDTO(a: AppointmentFull, user: CurrentUser): AppointmentDTO {
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
    brand: a.brand,
    model: a.model,
    description: a.description,
    requiredEquipment: a.requiredEquipment,
    additionalNotes: a.additionalNotes,
    ...(canNotes ? { internalNotes: a.internalNotes } : {}),
    startsAt: a.startsAt.toISOString(),
    endsAt: a.endsAt.toISOString(),
    durationMinutes: a.durationMinutes,
    status: {
      id: a.status.id,
      name: a.status.name,
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
  };
}

const listInclude = {
  customer: { select: { name: true, phone: true } },
  location: { select: { area: true, building: true, mapUrl: true, latitude: true } },
  status: { select: { id: true, name: true, kind: true, color: true } },
  createdBy: { select: userRefSelect },
  technicians: { select: { technician: { select: { id: true, name: true } } }, orderBy: { technician: { name: "asc" } } },
} satisfies Prisma.AppointmentInclude;

type AppointmentListRow = Prisma.AppointmentGetPayload<{ include: typeof listInclude }>;

function toListItem(a: AppointmentListRow, user: CurrentUser): AppointmentListItem {
  const canContact = hasPermission(user, "customers.contact");
  const canLocation = hasPermission(user, "location.view");
  return {
    id: a.id,
    code: appointmentCode(a.number),
    startsAt: a.startsAt.toISOString(),
    endsAt: a.endsAt.toISOString(),
    durationMinutes: a.durationMinutes,
    customerName: a.customer.name,
    ...(canContact ? { customerPhone: a.customer.phone } : {}),
    ...(canLocation
      ? {
          area: a.location.area,
          building: a.location.building,
          hasLocation: Boolean(a.location.mapUrl || a.location.latitude !== null),
        }
      : {}),
    productCategory: a.productCategory,
    categoryOther: a.categoryOther,
    brand: a.brand,
    model: a.model,
    status: a.status,
    createdBy: a.createdBy,
    technicians: a.technicians.map((t) => t.technician),
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
  if (!parsed.success) throw new ValidationError(fieldErrorsFromZod(parsed.error), "Invalid filters.");
  return parsed.data;
}

function contains(value: string) {
  return { contains: value, mode: "insensitive" as const };
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
  const where = buildAppointmentWhere(user, f);
  const orderBy: Prisma.AppointmentOrderByWithRelationInput[] =
    f.sort === "customer"
      ? [{ customer: { name: f.dir } }, { startsAt: "asc" }]
      : f.sort === "createdAt"
        ? [{ createdAt: f.dir }]
        : f.sort === "number"
          ? [{ number: f.dir }]
          : [{ startsAt: f.dir }, { number: "asc" }];
  const [total, rows] = await Promise.all([
    prisma.appointment.count({ where }),
    prisma.appointment.findMany({
      where,
      include: listInclude,
      orderBy,
      skip: (f.page - 1) * f.pageSize,
      take: f.pageSize,
    }),
  ]);
  return {
    rows: rows.map((r) => toListItem(r, user)),
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
    throw new ValidationError({ from: "Invalid date range" });
  }
  const { start, end } = dayRangeUtc(range.from, range.to, user.settings.timezone);
  if (end.getTime() - start.getTime() > 62 * 24 * 3600 * 1000) throw new ValidationError({ to: "Range too large" });
  const where = buildAppointmentWhere(user, { ...f, from: undefined, to: undefined });
  const rows = await prisma.appointment.findMany({
    where: { AND: [where, { startsAt: { lt: end } }, { endsAt: { gt: start } }] },
    include: listInclude,
    orderBy: [{ startsAt: "asc" }, { number: "asc" }],
    take: 3000,
  });
  return rows.map((r) => toListItem(r, user));
}

async function findVisibleAppointment(user: CurrentUser, id: string) {
  assertCan(user, "appointments.view");
  if (typeof id !== "string" || id.length > 64) throw new NotFoundError("Appointment not found.");
  // The scope is part of the query: a technician asking for someone else's appointment gets a
  // plain 404, exactly as if the ID did not exist.
  const appt = await prisma.appointment.findFirst({
    where: { AND: [{ id }, appointmentScope(user)] },
    include: appointmentInclude,
  });
  if (!appt) throw new NotFoundError("Appointment not found.");
  return appt;
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

export function redactChanges(user: CurrentUser, changes: unknown): AuditEntryDTO["changes"] {
  if (!changes || typeof changes !== "object") return null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(changes as Record<string, unknown>)) {
    const rule = FIELD_PERMISSIONS.find(([re]) => re.test(key));
    if (rule && !hasPermission(user, rule[1])) {
      out[key] = { from: "(hidden)", to: "(hidden)" };
    } else {
      out[key] = value;
    }
  }
  return out as AuditEntryDTO["changes"];
}

export async function getAppointmentHistory(user: CurrentUser, id: string): Promise<AuditEntryDTO[]> {
  assertCan(user, "history.view");
  const appt = await findVisibleAppointment(user, id);
  const rows = await prisma.auditLog.findMany({
    where: { appointmentId: appt.id },
    include: { actor: { select: { id: true, name: true } } },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    summary: r.summary,
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
      throw new ValidationError({ technicianIds: "One of the selected technicians does not exist." });
    }
    if (!u.isActive && !alreadyAssigned.includes(id)) {
      throw new ValidationError({ technicianIds: `${u.name} is inactive and cannot be assigned.` });
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
    if (!existing) throw new ValidationError({ "customer.id": "The selected customer no longer exists." });
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
      throw new ValidationError({ "location.id": "The selected location does not belong to this customer." });
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
    brand: a.brand,
    model: a.model,
    description: a.description,
    requiredEquipment: a.requiredEquipment,
    additionalNotes: a.additionalNotes,
    internalNotes: a.internalNotes,
  };
}

function whenLabel(startsAt: Date, endsAt: Date, tz: string) {
  return `${fmt(startsAt, tz, "EEE d MMM yyyy, HH:mm")}–${fmt(endsAt, tz, "HH:mm")}`;
}

async function loadFull(tx: Tx, id: string) {
  return tx.appointment.findUniqueOrThrow({ where: { id }, include: appointmentInclude });
}

async function resolveStatus(tx: Tx, statusId: string | null | undefined, current?: AppointmentStatus) {
  if (statusId) {
    if (current && current.id === statusId) return current;
    const s = await tx.appointmentStatus.findUnique({ where: { id: statusId } });
    if (!s || !s.isActive) throw new ValidationError({ statusId: "Choose a valid status." });
    return s;
  }
  if (current) return current;
  const s =
    (await tx.appointmentStatus.findFirst({ where: { isDefault: true, isActive: true } })) ??
    (await tx.appointmentStatus.findFirst({ where: { kind: "SCHEDULED", isActive: true }, orderBy: { sortOrder: "asc" } }));
  if (!s) throw new ValidationError({ statusId: "No active default status is configured." });
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
    if (user.role !== "ADMIN") throw new ForbiddenError("Only an Admin can create appointments on behalf of another employee.");
    const sales = await prisma.user.findUnique({ where: { id: input.salesUserId } });
    if (!sales || !sales.isActive || (sales.role !== "SALES" && sales.role !== "ADMIN")) {
      throw new ValidationError({ salesUserId: "Choose an active Sales employee." });
    }
    creatorId = sales.id;
  }

  const startsAt = zonedToUtc(input.date, input.startTime, tz);
  const endsAt = computeEnd(startsAt, input.durationMinutes);

  try {
    const id = await prisma.$transaction(async (tx) => {
      const status = await resolveStatus(tx, input.statusId);
      await validateTechnicians(tx, input.technicianIds, []);
      await lockTechnicians(tx, input.technicianIds);
      if (status.blocksSchedule) {
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
          brand: input.brand,
          model: input.model,
          description: input.description,
          requiredEquipment: input.requiredEquipment,
          additionalNotes: input.additionalNotes,
          internalNotes: input.internalNotes,
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
        summary: `Created ${code} for ${customer.name} on ${whenLabel(startsAt, endsAt, tz)}`,
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
          message: `New assignment ${code}: ${customer.name}, ${whenLabel(startsAt, endsAt, tz)}`,
        },
        user.id,
      );
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
  if (!rows.length) throw new NotFoundError("Appointment not found.");
}

/** Loads an appointment for modification, enforcing visibility, edit rights and optimistic locking. */
async function loadForUpdate(tx: Tx, user: CurrentUser, id: string, version?: number) {
  if (typeof id !== "string" || id.length > 64) throw new NotFoundError("Appointment not found.");
  await lockAppointmentRow(tx, id);
  const visible = await tx.appointment.findFirst({ where: { AND: [{ id }, appointmentScope(user)] }, select: { id: true } });
  if (!visible) throw new NotFoundError("Appointment not found.");
  const existing = await loadFull(tx, id);
  if (!canManageAppointment(user, existing)) {
    throw new ForbiddenError("You can only modify appointments you created.");
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
      const currentTechIds = existing.technicians.map((t) => t.technicianId);
      await validateTechnicians(tx, input.technicianIds, currentTechIds);
      await lockTechnicians(tx, [...currentTechIds, ...input.technicianIds]);
      if (status.blocksSchedule) {
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
          brand: input.brand,
          model: input.model,
          description: input.description,
          requiredEquipment: input.requiredEquipment,
          additionalNotes: input.additionalNotes,
          internalNotes: input.internalNotes,
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
          summary: `Updated details of ${code}`,
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
          summary: `Rescheduled ${code} from ${whenLabel(existing.startsAt, existing.endsAt, tz)} to ${whenLabel(startsAt, endsAt, tz)}`,
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
          summary: `Changed technicians of ${code}: ${afterNames.join(", ") || "none"}`,
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
          summary: `Changed status of ${code} from ${existing.status.name} to ${status.name}`,
          changes: { status: { from: existing.status.name, to: status.name } },
          actorId: user.id,
        });
      }
      for (const a of audits) await recordAudit(tx, a);

      const when = whenLabel(startsAt, endsAt, tz);
      await notifyUsers(tx, added, { appointmentId: id, type: "ASSIGNED", message: `New assignment ${code}: ${customer.name}, ${when}` }, user.id);
      await notifyUsers(tx, removed, { appointmentId: id, type: "UNASSIGNED", message: `You were removed from ${code} (${customer.name})` }, user.id);
      if (audits.length) {
        await notifyUsers(
          tx,
          kept,
          {
            appointmentId: id,
            type: timeChanged ? "RESCHEDULED" : "UPDATED",
            message: timeChanged ? `${code} was rescheduled to ${when}` : `${code} (${customer.name}) was updated`,
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
      if (!status) throw new ValidationError({ statusId: "No active cancellation status is configured." });
      if (status.id === existing.statusId) return;

      // Re-activating (e.g. un-cancelling) must not create a double booking.
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
          ? `Cancelled ${code}${note ? `: ${note}` : ""}`
          : `Changed status of ${code} from ${existing.status.name} to ${status.name}`,
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
            ? `${code} (${existing.customer.name}, ${whenLabel(existing.startsAt, existing.endsAt, tz)}) was cancelled`
            : `${code} status changed to ${status.name}`,
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

export function categoryLabel(a: { productCategory: ProductCategory; categoryOther: string | null }) {
  return a.productCategory === "OTHER" && a.categoryOther ? a.categoryOther : PRODUCT_CATEGORY_LABELS[a.productCategory];
}
