import "server-only";
import { Prisma } from "@prisma/client";
import { msg } from "@/i18n/translator";
import { addDaysToKey, dayRangeUtc, todayKey } from "@/lib/time";
import type { AppointmentListItem, FeedbackDTO } from "@/lib/types";
import { fieldErrorsFromZod, gradeSchema, maintenanceCallSchema, ratingSchema } from "@/lib/validation";
import { prisma } from "../db";
import { appointmentScope, appointmentScopeSql, assertCan, hasPermission } from "../access";
import type { CurrentUser } from "../auth/session";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { recordAudit } from "./audit";
import { appointmentListRows } from "./appointment-reads";
import { canManageAppointment } from "./appointments";

/**
 * After-sales follow-up from Aura: the customer's satisfaction rating (call 3-14 days after the
 * visit), the head of installations' quality grade (finished work with photos, last 30 days) and
 * maintenance reminder calls 6 and 12 months after an installation (from 7 days before to 21 days
 * after the date). Ratings and grades are not booking edits: they do not bump the version.
 */

/** Visits that have happened (a rating or grade makes no sense before). */
const VISITED = ["COMPLETED", "NEEDS_REVISIT", "UNABLE_TO_COMPLETE"] as const;
const LIST_LIMIT = 100;

async function visibleVisit(user: CurrentUser, id: string) {
  if (typeof id !== "string" || id.length > 64) throw new NotFoundError("errors.appointmentNotFound");
  const a = await prisma.appointment.findFirst({
    where: { AND: [{ id }, appointmentScope(user)] },
    select: {
      id: true,
      number: true,
      createdById: true,
      visitType: true,
      customerRating: true,
      ratingNote: true,
      qualityGrade: true,
      status: { select: { kind: true } },
      maintenanceCalls: { select: { milestone: true } },
    },
  });
  if (!a) throw new NotFoundError("errors.appointmentNotFound");
  return a;
}

const person = { select: { id: true, name: true } } as const;

export async function getFeedback(user: CurrentUser, appointmentId: string): Promise<FeedbackDTO> {
  if (typeof appointmentId !== "string" || appointmentId.length > 64) throw new NotFoundError("errors.appointmentNotFound");
  const a = await prisma.appointment.findFirst({
    where: { AND: [{ id: appointmentId }, appointmentScope(user)] },
    select: {
      createdById: true,
      visitType: true,
      status: { select: { kind: true } },
      customerRating: true,
      ratingNote: true,
      ratedAt: true,
      ratedBy: person,
      qualityGrade: true,
      gradedAt: true,
      gradedBy: person,
      maintenanceCalls: { select: { milestone: true, note: true, createdAt: true, calledBy: person }, orderBy: { milestone: "asc" } },
    },
  });
  if (!a) throw new NotFoundError("errors.appointmentNotFound");
  const manage = canManageAppointment(user, a);
  const done = a.status.kind === "COMPLETED";
  return {
    rating: a.customerRating,
    ratingNote: a.ratingNote,
    ratedBy: a.ratedBy,
    ratedAt: a.ratedAt?.toISOString() ?? null,
    grade: a.qualityGrade,
    gradedBy: a.gradedBy,
    gradedAt: a.gradedAt?.toISOString() ?? null,
    calls: a.maintenanceCalls.map((c) => ({ milestone: c.milestone as 6 | 12, note: c.note, calledBy: c.calledBy, createdAt: c.createdAt.toISOString() })),
    rights: {
      rate: manage && (VISITED as readonly string[]).includes(a.status.kind),
      grade: done && hasPermission(user, "quality.grade"),
      call: manage && done && a.visitType === "INSTALLATION",
    },
  };
}

export async function setCustomerRating(user: CurrentUser, appointmentId: string, raw: unknown) {
  const parsed = ratingSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(fieldErrorsFromZod(parsed.error));
  const a = await visibleVisit(user, appointmentId);
  if (!canManageAppointment(user, a)) throw new ForbiddenError();
  if (!(VISITED as readonly string[]).includes(a.status.kind)) throw new ValidationError({ rating: msg("afterSales.errors.notVisited") }, msg("afterSales.errors.notVisited"));
  const { rating } = parsed.data;
  const note = rating ? parsed.data.note : null;
  if (rating === a.customerRating && note === a.ratingNote) return { rating, note };
  await prisma.$transaction(async (tx) => {
    await tx.appointment.update({
      where: { id: a.id },
      data: rating ? { customerRating: rating, ratingNote: note, ratedAt: new Date(), ratedById: user.id } : { customerRating: null, ratingNote: null, ratedAt: null, ratedById: null },
    });
    await recordAudit(tx, {
      entityType: "APPOINTMENT",
      entityId: a.id,
      appointmentId: a.id,
      action: "CUSTOMER_RATING",
      summary: rating ? msg("audit.rated", { stars: rating }) : msg("audit.ratingCleared"),
      changes: { customerRating: { from: a.customerRating, to: rating }, ratingNote: { from: a.ratingNote, to: note } },
      actorId: user.id,
    });
  });
  return { rating, note };
}

export async function setQualityGrade(user: CurrentUser, appointmentId: string, raw: unknown) {
  assertCan(user, "quality.grade");
  const parsed = gradeSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(fieldErrorsFromZod(parsed.error));
  const a = await visibleVisit(user, appointmentId);
  if (a.status.kind !== "COMPLETED") throw new ValidationError({ grade: msg("afterSales.errors.notCompleted") }, msg("afterSales.errors.notCompleted"));
  const { grade } = parsed.data;
  if (grade === a.qualityGrade) return { grade };
  await prisma.$transaction(async (tx) => {
    await tx.appointment.update({
      where: { id: a.id },
      data: grade ? { qualityGrade: grade, gradedAt: new Date(), gradedById: user.id } : { qualityGrade: null, gradedAt: null, gradedById: null },
    });
    await recordAudit(tx, {
      entityType: "APPOINTMENT",
      entityId: a.id,
      appointmentId: a.id,
      action: "QUALITY_GRADE",
      summary: grade ? msg("audit.graded", { stars: grade }) : msg("audit.gradeCleared"),
      changes: { qualityGrade: { from: a.qualityGrade, to: grade } },
      actorId: user.id,
    });
  });
  return { grade };
}

export async function recordMaintenanceCall(user: CurrentUser, appointmentId: string, raw: unknown) {
  const parsed = maintenanceCallSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(fieldErrorsFromZod(parsed.error));
  const a = await visibleVisit(user, appointmentId);
  if (!canManageAppointment(user, a)) throw new ForbiddenError();
  if (a.status.kind !== "COMPLETED" || a.visitType !== "INSTALLATION") {
    throw new ValidationError({ milestone: msg("afterSales.errors.notInstallation") }, msg("afterSales.errors.notInstallation"));
  }
  const { milestone, note } = parsed.data;
  try {
    await prisma.$transaction(async (tx) => {
      await tx.maintenanceCall.create({ data: { appointmentId: a.id, milestone, note, calledById: user.id } });
      await recordAudit(tx, {
        entityType: "APPOINTMENT",
        entityId: a.id,
        appointmentId: a.id,
        action: "MAINTENANCE_CALL",
        summary: msg("audit.maintenanceCall", { months: milestone }),
        changes: { milestone, note },
        actorId: user.id,
      });
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new ValidationError({ milestone: msg("afterSales.errors.alreadyCalled") }, msg("afterSales.errors.alreadyCalled"));
    }
    throw e;
  }
  return { milestone, note };
}

export type AfterSalesList = "satisfaction" | "quality" | "maintenance";
export const AFTER_SALES_LISTS: AfterSalesList[] = ["satisfaction", "quality", "maintenance"];

/** Who sees which list: Sales and Admins call customers; the head of installations grades. */
export function afterSalesLists(user: CurrentUser): AfterSalesList[] {
  const out: AfterSalesList[] = [];
  if (hasPermission(user, "appointments.manage")) out.push("satisfaction");
  if (hasPermission(user, "quality.grade")) out.push("quality");
  if (hasPermission(user, "appointments.manage")) out.push("maintenance");
  return out;
}

/** The SQL conditions of each list over `appointments a` / `appointment_statuses s`. */
function listConditions(user: CurrentUser, now: Date) {
  const tz = user.settings.timezone;
  const today = todayKey(tz, now);
  const range = (fromDaysAgo: number, toDaysAgo: number) => dayRangeUtc(addDaysToKey(today, -fromDaysAgo), addDaysToKey(today, -toDaysAgo), tz);
  const calls = range(14, 3);
  const recent = range(30, 0);
  const due12 = range(365 + 21, 365 - 7);
  const due6 = range(182 + 21, 182 - 7);
  const call = (m: number) => Prisma.sql`EXISTS (SELECT 1 FROM maintenance_calls mc WHERE mc."appointmentId" = a.id AND mc.milestone = ${m})`;
  return {
    satisfaction: Prisma.sql`s.kind = 'COMPLETED' AND a."customerRating" IS NULL AND a."startsAt" >= ${calls.start} AND a."startsAt" < ${calls.end}`,
    quality: Prisma.sql`s.kind = 'COMPLETED' AND a."qualityGrade" IS NULL AND a."startsAt" >= ${recent.start} AND a."startsAt" < ${recent.end}
      AND EXISTS (SELECT 1 FROM attachments ph WHERE ph."appointmentId" = a.id AND ph.kind = 'AFTER_PHOTO' AND ph."deletedAt" IS NULL)`,
    maintenance: Prisma.sql`s.kind = 'COMPLETED' AND a."visitType" = 'INSTALLATION' AND (
      (a."startsAt" >= ${due12.start} AND a."startsAt" < ${due12.end} AND NOT ${call(12)})
      OR (a."startsAt" >= ${due6.start} AND a."startsAt" < ${due6.end} AND NOT ${call(6)} AND NOT ${call(12)}))`,
    due12,
  };
}

export type AfterSalesRow = AppointmentListItem & { canAct: boolean; dueMonths?: 6 | 12 };

export async function afterSalesList(user: CurrentUser, list: AfterSalesList, now: Date = new Date()): Promise<AfterSalesRow[]> {
  if (!afterSalesLists(user).includes(list)) throw new ForbiddenError();
  const cond = listConditions(user, now);
  const rows = await appointmentListRows(user, Prisma.sql`${appointmentScopeSql(user)} AND ${cond[list]}`, Prisma.sql`a."startsAt" ASC, a.number ASC`, LIST_LIMIT);
  const owners =
    list === "quality"
      ? new Map<string, string>()
      : new Map((await prisma.appointment.findMany({ where: { id: { in: rows.map((r) => r.id) } }, select: { id: true, createdById: true } })).map((r) => [r.id, r.createdById]));
  return rows.map((r) => ({
    ...r,
    canAct: list === "quality" ? true : canManageAppointment(user, { createdById: owners.get(r.id) ?? "" }),
    ...(list === "maintenance" ? { dueMonths: (new Date(r.startsAt) >= cond.due12.start && new Date(r.startsAt) < cond.due12.end ? 12 : 6) as 6 | 12 } : {}),
  }));
}

/**
 * Dashboard counts as extra columns of the dashboard's counter statement (complaints,
 * satisfaction, quality, maintenance), so the page needs no extra round trip. Columns the reader
 * has no list for are 0.
 */
export function afterSalesCountColumns(user: CurrentUser, now: Date = new Date()): { sql: Prisma.Sql; lists: AfterSalesList[]; complaints: boolean } {
  const lists = afterSalesLists(user);
  const complaints = hasPermission(user, "complaints.view") && user.role !== "TECHNICIAN";
  const cond = listConditions(user, now);
  const scope = appointmentScopeSql(user);
  const visit = (list: AfterSalesList) =>
    lists.includes(list)
      ? Prisma.sql`(SELECT count(*) FROM appointments a JOIN appointment_statuses s ON s.id = a."statusId" WHERE ${scope} AND ${cond[list]})::int`
      : Prisma.sql`0`;
  return {
    lists,
    complaints,
    sql: Prisma.sql`${complaints ? Prisma.sql`(SELECT count(*) FROM complaints c JOIN appointments a ON a.id = c."appointmentId" WHERE c.status <> 'CLOSED' AND ${scope})::int` : Prisma.sql`0`} AS complaints,
      ${visit("satisfaction")} AS satisfaction, ${visit("quality")} AS quality, ${visit("maintenance")} AS maintenance`,
  };
}
