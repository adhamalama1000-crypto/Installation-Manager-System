import "server-only";
import { Prisma, type ProductCategory, type StatusKind } from "@prisma/client";
import { appointmentCode, parseAppointmentCode, phoneDigits } from "@/lib/constants";
import type { AppointmentListItem } from "@/lib/types";
import { dayRangeUtc } from "@/lib/time";
import { prisma } from "../db";
import { appointmentScopeSql, hasPermission } from "../access";
import type { CurrentUser } from "../auth/session";
import type { AppointmentFilters } from "./appointments";

/**
 * Read queries for appointment lists, the calendar, the dashboard and CSV exports, in plain SQL.
 *
 * Prisma loads every `include`d relation with a separate query, one after the other (a list page
 * cost 6 round trips), and turns each OR'ed relation filter of the search into its own LEFT JOIN
 * over the whole table (a phone search joined customers 3x and locations 3x). These queries do
 * each job in a single round trip and use the indexes. `appointmentFilterSql` must stay
 * equivalent to `buildAppointmentWhere` (tests/integration/appointment-reads.test.ts checks this).
 */

/** Escapes LIKE wildcards so user input is matched literally. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

const containsPattern = (value: string) => `%${escapeLike(value)}%`;

/** SQL WHERE condition over `appointments a` for the list filters, including the row-level scope. */
export function appointmentFilterSql(user: CurrentUser, f: Partial<AppointmentFilters>): Prisma.Sql {
  const and: Prisma.Sql[] = [appointmentScopeSql(user)];
  const canLocation = hasPermission(user, "location.view");

  if (f.q) {
    const pattern = containsPattern(f.q);
    const customer: Prisma.Sql[] = [Prisma.sql`fc.name ILIKE ${pattern}`];
    const digits = phoneDigits(f.q);
    // Never let users search by data they are not allowed to see.
    if (hasPermission(user, "customers.contact") && digits.length >= 3) {
      const digitPattern = containsPattern(digits);
      customer.push(Prisma.sql`fc."phoneDigits" LIKE ${digitPattern}`, Prisma.sql`fc."secondaryPhoneDigits" LIKE ${digitPattern}`);
    }
    const or: Prisma.Sql[] = [
      Prisma.sql`a."customerId" IN (SELECT fc.id FROM customers fc WHERE ${Prisma.join(customer, " OR ")})`,
      Prisma.sql`a.brand ILIKE ${pattern}`,
      Prisma.sql`a.model ILIKE ${pattern}`,
      Prisma.sql`a."categoryOther" ILIKE ${pattern}`,
    ];
    const num = parseAppointmentCode(f.q);
    if (num) or.push(Prisma.sql`a.number = ${num}`);
    if (canLocation) {
      or.push(
        Prisma.sql`a."locationId" IN (SELECT fl.id FROM customer_locations fl
          WHERE fl."streetAddress" ILIKE ${pattern} OR fl.area ILIKE ${pattern} OR fl.building ILIKE ${pattern})`,
      );
    }
    and.push(Prisma.sql`(${Prisma.join(or, " OR ")})`);
  }
  if (f.status?.length) and.push(Prisma.sql`a."statusId" = ANY(${f.status}::text[])`);
  if (f.category) and.push(Prisma.sql`a."productCategory" = ${f.category}::"ProductCategory"`);
  if (f.salesId) and.push(Prisma.sql`a."createdById" = ${f.salesId}`);
  if (f.technicianId) {
    and.push(Prisma.sql`EXISTS (SELECT 1 FROM appointment_technicians ft WHERE ft."appointmentId" = a.id AND ft."technicianId" = ${f.technicianId})`);
  }
  if (f.area && canLocation) {
    const pattern = containsPattern(f.area);
    and.push(Prisma.sql`a."locationId" IN (SELECT fl.id FROM customer_locations fl WHERE fl.area ILIKE ${pattern} OR fl.building ILIKE ${pattern})`);
  }
  if (f.from || f.to) {
    const range = dayRangeUtc(f.from ?? "1970-01-01", f.to ?? "9999-12-30", user.settings.timezone);
    and.push(Prisma.sql`a."startsAt" >= ${range.start} AND a."startsAt" < ${range.end}`);
  }
  return Prisma.join(and, " AND ");
}

type ListRow = {
  id: string;
  number: number;
  startsAt: Date;
  endsAt: Date;
  durationMinutes: number;
  productCategory: ProductCategory;
  categoryOther: string | null;
  brand: string | null;
  model: string | null;
  customerName: string;
  customerPhone: string;
  area: string | null;
  building: string | null;
  hasLocation: boolean;
  statusId: string;
  statusName: string;
  statusKind: StatusKind;
  statusColor: string;
  creatorId: string;
  creatorName: string;
  creatorColor: string | null;
  creatorActive: boolean;
  technicians: { id: string; name: string }[];
};

/**
 * Loads list items matching `where` in one round trip. `where` and `orderBy` may use the aliases
 * a (appointment), c (customer), l (location), s (status) and u (creator).
 */
export async function appointmentListRows(
  user: CurrentUser,
  where: Prisma.Sql,
  orderBy: Prisma.Sql,
  limit: number,
  offset = 0,
  options: { orderedByCustomer?: boolean } = {},
): Promise<AppointmentListItem[]> {
  // `page` only picks the ids, so the per-row work is done for the rows returned, not for every
  // row skipped by OFFSET or cut by LIMIT, and `techs` collects the technicians of the whole page
  // at once. The joins in `page` are LEFT JOINs so PostgreSQL drops the ones the filter and order
  // do not use (the foreign keys are NOT NULL, so this returns the same rows as inner joins). When
  // sorting by customer name that join is INNER, so the planner can walk the name index instead.
  const customerJoin = Prisma.raw(options.orderedByCustomer ? "JOIN" : "LEFT JOIN");
  const rows = await prisma.$queryRaw<ListRow[]>`
    WITH page AS (
      SELECT a.id FROM appointments a
      ${customerJoin} customers c ON c.id = a."customerId"
      LEFT JOIN customer_locations l ON l.id = a."locationId"
      LEFT JOIN appointment_statuses s ON s.id = a."statusId"
      LEFT JOIN users u ON u.id = a."createdById"
      WHERE ${where}
      ORDER BY ${orderBy}
      LIMIT ${limit} OFFSET ${offset}
    ), techs AS (
      SELECT at."appointmentId" AS id, json_agg(json_build_object('id', t.id, 'name', t.name) ORDER BY t.name, t.id) AS list
      FROM appointment_technicians at JOIN users t ON t.id = at."technicianId"
      WHERE at."appointmentId" IN (SELECT id FROM page)
      GROUP BY at."appointmentId"
    )
    SELECT a.id, a.number, a."startsAt", a."endsAt", a."durationMinutes", a."productCategory", a."categoryOther", a.brand, a.model,
           c.name AS "customerName", c.phone AS "customerPhone",
           l.area, l.building, (l."mapUrl" IS NOT NULL OR l.latitude IS NOT NULL) AS "hasLocation",
           s.id AS "statusId", s.name AS "statusName", s.kind AS "statusKind", s.color AS "statusColor",
           u.id AS "creatorId", u.name AS "creatorName", u.color AS "creatorColor", u."isActive" AS "creatorActive",
           COALESCE(techs.list, '[]'::json) AS technicians
    FROM page
    JOIN appointments a ON a.id = page.id
    JOIN customers c ON c.id = a."customerId"
    JOIN customer_locations l ON l.id = a."locationId"
    JOIN appointment_statuses s ON s.id = a."statusId"
    JOIN users u ON u.id = a."createdById"
    LEFT JOIN techs ON techs.id = a.id
    ORDER BY ${orderBy}`;
  const canContact = hasPermission(user, "customers.contact");
  const canLocation = hasPermission(user, "location.view");
  return rows.map((r) => ({
    id: r.id,
    code: appointmentCode(r.number),
    startsAt: r.startsAt.toISOString(),
    endsAt: r.endsAt.toISOString(),
    durationMinutes: r.durationMinutes,
    customerName: r.customerName,
    ...(canContact ? { customerPhone: r.customerPhone } : {}),
    ...(canLocation ? { area: r.area, building: r.building, hasLocation: r.hasLocation } : {}),
    productCategory: r.productCategory,
    categoryOther: r.categoryOther,
    brand: r.brand,
    model: r.model,
    status: { id: r.statusId, name: r.statusName, kind: r.statusKind, color: r.statusColor },
    createdBy: { id: r.creatorId, name: r.creatorName, color: r.creatorColor, isActive: r.creatorActive },
    technicians: r.technicians,
  }));
}

export async function countAppointments(where: Prisma.Sql): Promise<number> {
  const rows = await prisma.$queryRaw<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM appointments a WHERE ${where}`;
  return rows[0]?.n ?? 0;
}

/** ORDER BY for the list's sort options. Joins in appointmentListRows provide `c` (customer). */
export function appointmentOrderSql(sort: AppointmentFilters["sort"], dir: AppointmentFilters["dir"]): Prisma.Sql {
  const d = Prisma.raw(dir === "asc" ? "ASC" : "DESC");
  switch (sort) {
    case "customer":
      return Prisma.sql`c.name ${d}, a."startsAt" ASC, a.id`;
    case "createdAt":
      return Prisma.sql`a."createdAt" ${d}, a.id`;
    case "number":
      return Prisma.sql`a.number ${d}`;
    default:
      return Prisma.sql`a."startsAt" ${d}, a.number ASC`;
  }
}

export type ExportRow = {
  number: number;
  startsAt: Date;
  endsAt: Date;
  durationMinutes: number;
  productCategory: ProductCategory;
  categoryOther: string | null;
  brand: string | null;
  model: string | null;
  statusName: string;
  customerName: string;
  phone: string;
  secondaryPhone: string | null;
  area: string | null;
  streetAddress: string | null;
  building: string | null;
  apartment: string | null;
  floor: string | null;
  mapUrl: string | null;
  creatorName: string;
  technicianNames: string | null;
};

/** Flat rows for CSV exports. Callers decide which columns the user may see. */
export async function appointmentExportRows(where: Prisma.Sql, dir: "asc" | "desc", limit = 20_000): Promise<ExportRow[]> {
  const order = Prisma.sql`a."startsAt" ${Prisma.raw(dir === "asc" ? "ASC" : "DESC")}, a.number`;
  // Technician names are aggregated once for all exported rows (not by a sub-query per row).
  return prisma.$queryRaw<ExportRow[]>`
    WITH picked AS (
      SELECT a.id FROM appointments a WHERE ${where} ORDER BY ${order} LIMIT ${limit}
    ), techs AS (
      SELECT at."appointmentId" AS id, string_agg(t.name, '; ' ORDER BY t.name) AS names
      FROM appointment_technicians at JOIN users t ON t.id = at."technicianId"
      WHERE at."appointmentId" IN (SELECT id FROM picked)
      GROUP BY at."appointmentId"
    )
    SELECT a.number, a."startsAt", a."endsAt", a."durationMinutes", a."productCategory", a."categoryOther", a.brand, a.model,
           s.name AS "statusName", c.name AS "customerName", c.phone, c."secondaryPhone",
           l.area, l."streetAddress", l.building, l.apartment, l.floor, l."mapUrl", u.name AS "creatorName",
           techs.names AS "technicianNames"
    FROM picked
    JOIN appointments a ON a.id = picked.id
    JOIN customers c ON c.id = a."customerId"
    JOIN customer_locations l ON l.id = a."locationId"
    JOIN appointment_statuses s ON s.id = a."statusId"
    JOIN users u ON u.id = a."createdById"
    LEFT JOIN techs ON techs.id = a.id
    ORDER BY ${order}`;
}
