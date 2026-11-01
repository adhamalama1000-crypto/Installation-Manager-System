import "server-only";
import { Prisma } from "@prisma/client";
import { phoneDigits } from "@/lib/constants";
import { resolveLocationLink } from "@/lib/maps";
import { prisma } from "../db";
import { appointmentScopeSql, assertCan, hasPermission } from "../access";
import type { CurrentUser } from "../auth/session";
import { NotFoundError } from "../errors";
import { appointmentListRows, escapeLike } from "./appointment-reads";

function locationDTO(l: Prisma.CustomerLocationGetPayload<object>) {
  const latitude = l.latitude?.toNumber() ?? null;
  const longitude = l.longitude?.toNumber() ?? null;
  return {
    id: l.id,
    area: l.area,
    streetAddress: l.streetAddress,
    building: l.building,
    apartment: l.apartment,
    floor: l.floor,
    accessInstructions: l.accessInstructions,
    mapUrl: l.mapUrl,
    latitude,
    longitude,
    link: resolveLocationLink({ mapUrl: l.mapUrl, latitude, longitude }),
  };
}

export type CustomerMatch = {
  id: string;
  name: string;
  phone: string;
  secondaryPhone: string | null;
  locations: ReturnType<typeof locationDTO>[];
};

/** Repeat-customer lookup used by the booking form (Sales/Admin only). */
export async function lookupCustomers(user: CurrentUser, query: string): Promise<CustomerMatch[]> {
  assertCan(user, "appointments.manage");
  const q = query.trim().slice(0, 100);
  const digits = phoneDigits(q);
  if (q.length < 2) return [];
  const or: Prisma.CustomerWhereInput[] = [{ name: { contains: escapeLike(q), mode: "insensitive" } }];
  if (digits.length >= 4) or.push({ phoneDigits: { contains: digits } }, { secondaryPhoneDigits: { contains: digits } });
  const rows = await prisma.customer.findMany({
    where: { OR: or },
    include: { locations: { orderBy: { updatedAt: "desc" } } },
    orderBy: { updatedAt: "desc" },
    take: 8,
  });
  return rows.map((c) => ({
    id: c.id,
    name: c.name,
    phone: c.phone,
    secondaryPhone: c.secondaryPhone,
    locations: c.locations.map(locationDTO),
  }));
}

type CustomerListRow = { id: string; name: string; phone: string; area: string | null; appointments: number; locations: number; lastAppointment: Date | null };

export async function listCustomers(user: CurrentUser, opts: { q?: string; page?: number; pageSize?: number }) {
  assertCan(user, "customers.view");
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 25));
  const q = opts.q?.trim().slice(0, 100);
  let where = Prisma.sql`TRUE`;
  if (q) {
    // Each alternative is its own index-friendly subquery (trigram indexes), instead of one
    // OR across a correlated EXISTS that forces a scan of every customer.
    const pattern = `%${escapeLike(q)}%`;
    const own: Prisma.Sql[] = [Prisma.sql`name ILIKE ${pattern}`];
    const digits = phoneDigits(q);
    if (hasPermission(user, "customers.contact") && digits.length >= 3) {
      own.push(Prisma.sql`"phoneDigits" LIKE ${`%${digits}%`}`, Prisma.sql`"secondaryPhoneDigits" LIKE ${`%${digits}%`}`);
    }
    const sets = [Prisma.sql`SELECT id FROM customers WHERE ${Prisma.join(own, " OR ")}`];
    if (hasPermission(user, "location.view")) {
      sets.push(
        Prisma.sql`SELECT "customerId" FROM customer_locations
          WHERE area ILIKE ${pattern} OR building ILIKE ${pattern} OR "streetAddress" ILIKE ${pattern}`,
      );
    }
    where = Prisma.sql`c.id IN (${Prisma.join(sets, " UNION ")})`;
  }
  // Page first, then compute the per-customer figures for just that page.
  const [totals, rows] = await Promise.all([
    prisma.$queryRaw<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM customers c WHERE ${where}`,
    prisma.$queryRaw<CustomerListRow[]>`
      SELECT p.id, p.name, p.phone,
             (SELECT l.area FROM customer_locations l WHERE l."customerId" = p.id ORDER BY l."updatedAt" DESC LIMIT 1) AS area,
             (SELECT COUNT(*)::int FROM appointments a WHERE a."customerId" = p.id) AS appointments,
             (SELECT COUNT(*)::int FROM customer_locations l WHERE l."customerId" = p.id) AS locations,
             (SELECT MAX(a."startsAt") FROM appointments a WHERE a."customerId" = p.id) AS "lastAppointment"
      FROM (SELECT c.id, c.name, c.phone, c."updatedAt" FROM customers c WHERE ${where}
            ORDER BY c."updatedAt" DESC, c.id LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}) p
      ORDER BY p."updatedAt" DESC, p.id`,
  ]);
  const total = totals[0]?.n ?? 0;
  const contact = hasPermission(user, "customers.contact");
  const loc = hasPermission(user, "location.view");
  return {
    total,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
    rows: rows.map((c) => ({
      id: c.id,
      name: c.name,
      phone: contact ? c.phone : undefined,
      area: loc ? c.area : undefined,
      appointments: c.appointments,
      locations: c.locations,
      lastAppointment: c.lastAppointment?.toISOString() ?? null,
    })),
  };
}

export async function getCustomer(user: CurrentUser, id: string) {
  assertCan(user, "customers.view");
  if (typeof id !== "string" || id.length > 64) throw new NotFoundError("errors.customerNotFound");
  const [c, appts] = await Promise.all([
    prisma.customer.findUnique({ where: { id }, include: { locations: { orderBy: { updatedAt: "desc" } } } }),
    // Only appointments this user may see.
    appointmentListRows(user, Prisma.sql`${appointmentScopeSql(user)} AND a."customerId" = ${id}`, Prisma.sql`a."startsAt" DESC, a.number ASC`, 100),
  ]);
  if (!c) throw new NotFoundError("errors.customerNotFound");
  const contact = hasPermission(user, "customers.contact");
  return {
    id: c.id,
    name: c.name,
    phone: contact ? c.phone : undefined,
    secondaryPhone: contact ? c.secondaryPhone : undefined,
    createdAt: c.createdAt.toISOString(),
    locations: hasPermission(user, "location.view") ? c.locations.map(locationDTO) : null,
    appointments: appts.map((a) => ({
      id: a.id,
      code: a.code,
      startsAt: a.startsAt,
      endsAt: a.endsAt,
      status: { name: a.status.name, color: a.status.color, kind: a.status.kind },
      productCategory: a.productCategory,
      categoryOther: a.categoryOther,
      brand: a.brand,
      model: a.model,
      createdBy: a.createdBy,
    })),
  };
}
