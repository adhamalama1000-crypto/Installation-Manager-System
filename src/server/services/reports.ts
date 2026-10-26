import "server-only";
import type { Locale } from "@/i18n/config";
import type { MessageKey } from "@/i18n/messages";
import { enumLabel, localName, msg, translate } from "@/i18n/translate";
import { Prisma, type ProductCategory, type StatusKind } from "@prisma/client";
import { PRODUCT_CATEGORY_LABELS, appointmentCode } from "@/lib/constants";
import { dayRangeUtc, fmt, isValidDateString } from "@/lib/time";
import { prisma } from "../db";
import { appointmentScope, assertCan, hasPermission } from "../access";
import type { CurrentUser } from "../auth/session";
import { ValidationError } from "../errors";
import { appointmentExportRows, appointmentFilterSql } from "./appointment-reads";

export type ReportRange = { from: string; to: string };

function checkRange(r: ReportRange) {
  if (!isValidDateString(r.from) || !isValidDateString(r.to) || r.from > r.to) {
    throw new ValidationError({ from: msg("e.invalidRange") });
  }
}

export async function buildReport(user: CurrentUser, range: ReportRange) {
  assertCan(user, "reports.view");
  checkRange(range);
  const tz = user.settings.timezone;
  const { start, end } = dayRangeUtc(range.from, range.to, tz);
  const where: Prisma.AppointmentWhereInput = { AND: [appointmentScope(user), { startsAt: { gte: start, lt: end } }] };
  // The two raw SQL aggregates below are company-wide. That is correct because reports.view is
  // never granted to assignment-scoped roles (technicians); guard against that changing.
  if (user.role === "TECHNICIAN") throw new ValidationError({ _form: msg("e.reportsNotForTechnicians") });

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
      return { id: s.id, name: s.name, nameAr: s.nameAr, kind: s.kind, color: s.color, count: r._count._all, sortOrder: s.sortOrder };
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
    .map((r) => ({ category: r.productCategory as ProductCategory, label: PRODUCT_CATEGORY_LABELS[r.productCategory], count: r._count._all }))
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

export async function reportCsv(user: CurrentUser, type: ReportType, range: ReportRange, locale: Locale = "en"): Promise<string> {
  assertCan(user, "reports.view");
  checkRange(range);
  const t = (key: MessageKey) => translate(locale, key);
  const yesNo = (v: boolean) => t(v ? "common.yes" : "common.no");
  if (type === "appointments") return appointmentsCsv(user, range, locale);
  const r = await buildReport(user, range);
  switch (type) {
    case "status":
      return toCsv([[t("csv.status"), t("csv.appointments")], ...r.byStatus.map((s) => [localName(locale, s), s.count])]);
    case "sales":
      return toCsv([[t("csv.salesEmployee"), t("csv.active"), t("csv.appointments")], ...r.bySales.map((s) => [s.name, yesNo(s.isActive), s.count])]);
    case "technicians":
      return toCsv([
        [t("csv.technician"), t("csv.active"), t("csv.jobs"), t("csv.hours"), t("csv.completed"), t("csv.cancelled")],
        ...r.byTechnician.map((x) => [x.name, yesNo(x.isActive), x.jobs, (x.minutes / 60).toFixed(1), x.completed, x.cancelled]),
      ]);
    case "categories":
      return toCsv([[t("csv.category"), t("csv.appointments")], ...r.byCategory.map((c) => [enumLabel(locale, "category", c.category), c.count])]);
    case "daily":
      return toCsv([[t("csv.date"), t("csv.appointments")], ...r.daily.map((d) => [d.day, d.count])]);
  }
}

type ExportRow = Awaited<ReturnType<typeof appointmentExportRows>>[number];

/**
 * Appointment rows as CSV in the reader's language. Dates stay ISO (yyyy-MM-dd, HH:mm) and numbers
 * unformatted so spreadsheets read them; codes, phones and names are written as stored.
 */
export function appointmentRowsCsv(
  rows: ExportRow[],
  opts: { contact: boolean; location: boolean; secondaryPhone?: boolean; duration?: boolean },
  locale: Locale,
  tz: string,
): string {
  const t = (key: MessageKey) => translate(locale, key);
  // Internal notes are never exported.
  const header = [
    t("csv.appointmentId"),
    t("csv.date"),
    t("csv.start"),
    t("csv.end"),
    ...(opts.duration ? [t("csv.duration")] : []),
    t("csv.status"),
    t("csv.customer"),
    ...(opts.contact ? [t("csv.phone"), ...(opts.secondaryPhone ? [t("csv.secondaryPhone")] : [])] : []),
    ...(opts.location ? [t("csv.area"), t("csv.address"), t("csv.building"), t("csv.apartment"), t("csv.floor"), t("csv.mapLink")] : []),
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
      ...(opts.duration ? [a.durationMinutes] : []),
      localName(locale, { name: a.statusName, nameAr: a.statusNameAr }),
      a.customerName,
      ...(opts.contact ? [a.phone, ...(opts.secondaryPhone ? [a.secondaryPhone] : [])] : []),
      ...(opts.location ? [a.area, a.streetAddress, a.building, a.apartment, a.floor, a.mapUrl] : []),
      a.productCategory === "OTHER" && a.categoryOther ? a.categoryOther : enumLabel(locale, "category", a.productCategory),
      a.brand,
      a.model,
      a.creatorName,
      a.technicianNames ?? "",
    ]),
  ]);
}

async function appointmentsCsv(user: CurrentUser, range: ReportRange, locale: Locale) {
  const rows = await appointmentExportRows(appointmentFilterSql(user, { from: range.from, to: range.to }), "asc");
  return appointmentRowsCsv(
    rows,
    { contact: hasPermission(user, "customers.contact"), location: hasPermission(user, "location.view"), secondaryPhone: true, duration: true },
    locale,
    user.settings.timezone,
  );
}
