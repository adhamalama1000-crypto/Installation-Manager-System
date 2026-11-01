import "server-only";
import { Prisma, type ProductCategory, type StatusKind } from "@prisma/client";
import { createT, msg } from "@/i18n/translator";
import { appointmentCode } from "@/lib/constants";
import { categoryText, statusName } from "@/lib/format";
import { dayRangeUtc, fmt, isValidDateString } from "@/lib/time";
import { prisma } from "../db";
import { appointmentScope, assertCan, hasPermission } from "../access";
import type { CurrentUser } from "../auth/session";
import { ValidationError } from "../errors";
import { appointmentExportRows, appointmentFilterSql, type ExportRow } from "./appointment-reads";

export type ReportRange = { from: string; to: string };

function checkRange(r: ReportRange) {
  if (!isValidDateString(r.from) || !isValidDateString(r.to) || r.from > r.to) {
    throw new ValidationError({ from: msg("reportErrors.range") });
  }
}

export async function buildReport(user: CurrentUser, range: ReportRange) {
  assertCan(user, "reports.view");
  checkRange(range);
  const t = createT(user.locale);
  const tz = user.settings.timezone;
  const { start, end } = dayRangeUtc(range.from, range.to, tz);
  const where: Prisma.AppointmentWhereInput = { AND: [appointmentScope(user), { startsAt: { gte: start, lt: end } }] };
  // The two raw SQL aggregates below are company-wide. That is correct because reports.view is
  // never granted to assignment-scoped roles (technicians); guard against that changing.
  if (user.role === "TECHNICIAN") throw new ValidationError({ _form: msg("reportErrors.technicians") });

  const [total, byStatusRaw, bySalesRaw, byCategoryRaw, statuses, users, workloadRaw, dailyRaw] = await Promise.all([
    prisma.appointment.count({ where }),
    prisma.appointment.groupBy({ by: ["statusId"], where, _count: { _all: true } }),
    prisma.appointment.groupBy({ by: ["createdById"], where, _count: { _all: true } }),
    prisma.appointment.groupBy({ by: ["productCategory"], where, _count: { _all: true } }),
    prisma.appointmentStatus.findMany(),
    prisma.user.findMany({ select: { id: true, name: true, color: true, isActive: true, role: true } }),
    prisma.$queryRaw<{ technicianId: string; kind: StatusKind; jobs: bigint; minutes: bigint }[]>`
      SELECT at."technicianId", s.kind, COUNT(*)::bigint AS jobs, COALESCE(SUM(a."durationMinutes"), 0)::bigint AS minutes
      FROM appointment_technicians at
      JOIN appointments a ON a.id = at."appointmentId"
      JOIN appointment_statuses s ON s.id = a."statusId"
      WHERE a."startsAt" >= ${start} AND a."startsAt" < ${end}
      GROUP BY at."technicianId", s.kind`,
    prisma.$queryRaw<{ day: string; jobs: bigint }[]>`
      SELECT to_char(a."startsAt" AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS day, COUNT(*)::bigint AS jobs
      FROM appointments a
      WHERE a."startsAt" >= ${start} AND a."startsAt" < ${end}
      GROUP BY day ORDER BY day`,
  ]);

  const statusById = new Map(statuses.map((s) => [s.id, s]));
  const userById = new Map(users.map((u) => [u.id, u]));

  const byStatus = byStatusRaw
    .map((r) => {
      const s = statusById.get(r.statusId)!;
      return { id: s.id, name: statusName(s, user.locale), kind: s.kind, color: s.color, count: r._count._all, sortOrder: s.sortOrder };
    })
    .sort((a, b) => a.sortOrder - b.sortOrder);

  const kindCount = (kind: StatusKind) => byStatus.filter((s) => s.kind === kind).reduce((n, s) => n + s.count, 0);

  const bySales = bySalesRaw
    .map((r) => {
      const u = userById.get(r.createdById)!;
      return { id: u.id, name: u.name, color: u.color, isActive: u.isActive, count: r._count._all };
    })
    .sort((a, b) => b.count - a.count);

  const byCategory = byCategoryRaw
    .map((r) => ({ category: r.productCategory as ProductCategory, label: t.dyn(`enums.productCategory.${r.productCategory}`), count: r._count._all }))
    .sort((a, b) => b.count - a.count);

  const workloadMap = new Map<string, { id: string; name: string; isActive: boolean; jobs: number; minutes: number; completed: number; cancelled: number }>();
  for (const r of workloadRaw) {
    const u = userById.get(r.technicianId);
    if (!u) continue;
    const w = workloadMap.get(u.id) ?? { id: u.id, name: u.name, isActive: u.isActive, jobs: 0, minutes: 0, completed: 0, cancelled: 0 };
    const jobs = Number(r.jobs);
    if (r.kind === "CANCELLED") {
      w.cancelled += jobs;
    } else {
      w.jobs += jobs;
      w.minutes += Number(r.minutes);
      if (r.kind === "COMPLETED") w.completed += jobs;
    }
    workloadMap.set(u.id, w);
  }
  const byTechnician = [...workloadMap.values()].sort((a, b) => b.minutes - a.minutes);

  return {
    range,
    total,
    completed: kindCount("COMPLETED"),
    cancelled: kindCount("CANCELLED"),
    byStatus,
    bySales,
    byCategory,
    byTechnician,
    daily: dailyRaw.map((d) => ({ day: d.day, count: Number(d.jobs) })),
  };
}

function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  // Neutralise spreadsheet formula injection.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: unknown[][]): string {
  return "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

export const REPORT_TYPES = ["appointments", "status", "sales", "technicians", "categories", "daily"] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

export async function reportCsv(user: CurrentUser, type: ReportType, range: ReportRange): Promise<string> {
  assertCan(user, "reports.view");
  checkRange(range);
  if (type === "appointments") return appointmentsCsv(user, range);
  const r = await buildReport(user, range);
  const t = createT(user.locale);
  const yesNo = (v: boolean) => (v ? t("common.yes") : t("common.no"));
  switch (type) {
    case "status":
      return toCsv([[t("csv.status"), t("csv.appointments")], ...r.byStatus.map((s) => [s.name, s.count])]);
    case "sales":
      return toCsv([[t("csv.salesEmployee"), t("csv.active"), t("csv.appointments")], ...r.bySales.map((s) => [s.name, yesNo(s.isActive), s.count])]);
    case "technicians":
      return toCsv([
        [t("csv.technician"), t("csv.active"), t("csv.jobs"), t("csv.hours"), t("csv.completed"), t("csv.cancelled")],
        ...r.byTechnician.map((w) => [w.name, yesNo(w.isActive), w.jobs, (w.minutes / 60).toFixed(1), w.completed, w.cancelled]),
      ]);
    case "categories":
      return toCsv([[t("csv.category"), t("csv.appointments")], ...r.byCategory.map((c) => [c.label, c.count])]);
    case "daily":
      return toCsv([[t("csv.date"), t("csv.appointments")], ...r.daily.map((d) => [d.day, d.count])]);
  }
}

async function appointmentsCsv(user: CurrentUser, range: ReportRange) {
  const rows = await appointmentExportRows(appointmentFilterSql(user, { from: range.from, to: range.to }), "asc");
  return appointmentRowsCsv(user, rows, { detailed: true });
}

/**
 * CSV of appointment rows in the reader's language. Columns follow the reader's permissions;
 * internal notes are never exported. `detailed` adds the duration and the secondary phone.
 */
export function appointmentRowsCsv(user: CurrentUser, rows: ExportRow[], { detailed }: { detailed: boolean }) {
  const tz = user.settings.timezone;
  const t = createT(user.locale);
  const contact = hasPermission(user, "customers.contact");
  const loc = hasPermission(user, "location.view");
  const header = [
    t("csv.appointmentId"),
    t("csv.date"),
    t("csv.start"),
    t("csv.end"),
    ...(detailed ? [t("csv.durationMin")] : []),
    t("csv.status"),
    t("csv.customer"),
    ...(contact ? [t("csv.phone"), ...(detailed ? [t("csv.secondaryPhone")] : [])] : []),
    ...(loc ? [t("csv.area"), t("csv.address"), t("csv.building"), t("csv.apartment"), t("csv.floor"), t("csv.mapLink")] : []),
    t("csv.category"),
    t("csv.brand"),
    t("csv.model"),
    t("csv.salesEmployee"),
    t("csv.technicians"),
  ];
  return toCsv([
    header,
    ...rows.map((a) => [
      appointmentCode(a.number),
      fmt(a.startsAt, tz, "yyyy-MM-dd"),
      fmt(a.startsAt, tz, "HH:mm"),
      fmt(a.endsAt, tz, "HH:mm"),
      ...(detailed ? [a.durationMinutes] : []),
      statusName({ name: a.statusName, nameAr: a.statusNameAr }, user.locale),
      a.customerName,
      ...(contact ? [a.phone, ...(detailed ? [a.secondaryPhone] : [])] : []),
      ...(loc ? [a.area, a.streetAddress, a.building, a.apartment, a.floor, a.mapUrl] : []),
      categoryText(a, t),
      a.brand,
      a.model,
      a.creatorName,
      a.technicianNames ?? "",
    ]),
  ]);
}
