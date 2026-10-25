import "server-only";
import { Prisma, type ProductCategory, type StatusKind } from "@prisma/client";
import { PRODUCT_CATEGORY_LABELS, appointmentCode } from "@/lib/constants";
import { dayRangeUtc, fmt, isValidDateString } from "@/lib/time";
import { prisma } from "../db";
import { appointmentScope, assertCan, hasPermission } from "../access";
import type { CurrentUser } from "../auth/session";
import { ValidationError } from "../errors";
import { categoryLabel } from "./appointments";
import { appointmentExportRows, appointmentFilterSql } from "./appointment-reads";

export type ReportRange = { from: string; to: string };

function checkRange(r: ReportRange) {
  if (!isValidDateString(r.from) || !isValidDateString(r.to) || r.from > r.to) {
    throw new ValidationError({ from: "Choose a valid date range." });
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
  if (user.role === "TECHNICIAN") throw new ValidationError({ _form: "Reports are not available for technicians." });

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
      return { id: s.id, name: s.name, kind: s.kind, color: s.color, count: r._count._all, sortOrder: s.sortOrder };
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

export async function reportCsv(user: CurrentUser, type: ReportType, range: ReportRange): Promise<string> {
  assertCan(user, "reports.view");
  checkRange(range);
  if (type === "appointments") return appointmentsCsv(user, range);
  const r = await buildReport(user, range);
  switch (type) {
    case "status":
      return toCsv([["Status", "Appointments"], ...r.byStatus.map((s) => [s.name, s.count])]);
    case "sales":
      return toCsv([["Sales employee", "Active", "Appointments"], ...r.bySales.map((s) => [s.name, s.isActive ? "Yes" : "No", s.count])]);
    case "technicians":
      return toCsv([
        ["Technician", "Active", "Jobs (not cancelled)", "Hours", "Completed", "Cancelled"],
        ...r.byTechnician.map((t) => [t.name, t.isActive ? "Yes" : "No", t.jobs, (t.minutes / 60).toFixed(1), t.completed, t.cancelled]),
      ]);
    case "categories":
      return toCsv([["Category", "Appointments"], ...r.byCategory.map((c) => [c.label, c.count])]);
    case "daily":
      return toCsv([["Date", "Appointments"], ...r.daily.map((d) => [d.day, d.count])]);
  }
}

async function appointmentsCsv(user: CurrentUser, range: ReportRange) {
  const tz = user.settings.timezone;
  const rows = await appointmentExportRows(appointmentFilterSql(user, { from: range.from, to: range.to }), "asc");
  const contact = hasPermission(user, "customers.contact");
  const loc = hasPermission(user, "location.view");
  // Internal notes are never exported.
  const header = [
    "Appointment ID",
    "Date",
    "Start",
    "End",
    "Duration (min)",
    "Status",
    "Customer",
    ...(contact ? ["Phone", "Secondary phone"] : []),
    ...(loc ? ["Area", "Address", "Compound/Building", "Apartment", "Floor", "Map link"] : []),
    "Category",
    "Brand",
    "Model",
    "Sales employee",
    "Technicians",
  ];
  return toCsv([
    header,
    ...rows.map((a) => [
      appointmentCode(a.number),
      fmt(a.startsAt, tz, "yyyy-MM-dd"),
      fmt(a.startsAt, tz, "HH:mm"),
      fmt(a.endsAt, tz, "HH:mm"),
      a.durationMinutes,
      a.statusName,
      a.customerName,
      ...(contact ? [a.phone, a.secondaryPhone] : []),
      ...(loc ? [a.area, a.streetAddress, a.building, a.apartment, a.floor, a.mapUrl] : []),
      categoryLabel(a),
      a.brand,
      a.model,
      a.creatorName,
      a.technicianNames ?? "",
    ]),
  ]);
}
