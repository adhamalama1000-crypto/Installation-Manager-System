import "server-only";
import type { Prisma } from "@prisma/client";
import { phoneDigits } from "@/lib/constants";
import { resolveLocationLink } from "@/lib/maps";
import { prisma } from "../db";
import { assertCan, hasPermission } from "../access";
import type { CurrentUser } from "../auth/session";
import { NotFoundError } from "../errors";
import { buildAppointmentWhere } from "./appointments";
import { appointmentCode } from "@/lib/constants";

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
  const or: Prisma.CustomerWhereInput[] = [{ name: { contains: q, mode: "insensitive" } }];
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

export async function listCustomers(user: CurrentUser, opts: { q?: string; page?: number; pageSize?: number }) {
  assertCan(user, "customers.view");
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 25));
  const q = opts.q?.trim().slice(0, 100);
  const where: Prisma.CustomerWhereInput = {};
  if (q) {
    const or: Prisma.CustomerWhereInput[] = [{ name: { contains: q, mode: "insensitive" } }];
    const digits = phoneDigits(q);
    if (hasPermission(user, "customers.contact") && digits.length >= 3) {
      or.push({ phoneDigits: { contains: digits } }, { secondaryPhoneDigits: { contains: digits } });
    }
    if (hasPermission(user, "location.view")) {
      or.push({
        locations: {
          some: {
            OR: [
              { area: { contains: q, mode: "insensitive" } },
              { building: { contains: q, mode: "insensitive" } },
              { streetAddress: { contains: q, mode: "insensitive" } },
            ],
          },
        },
      });
    }
    where.OR = or;
  }
  const [total, rows] = await Promise.all([
    prisma.customer.count({ where }),
    prisma.customer.findMany({
      where,
      include: {
        _count: { select: { appointments: true, locations: true } },
        appointments: { select: { startsAt: true }, orderBy: { startsAt: "desc" }, take: 1 },
        locations: { select: { area: true }, orderBy: { updatedAt: "desc" }, take: 1 },
      },
      orderBy: { updatedAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);
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
      area: loc ? (c.locations[0]?.area ?? null) : undefined,
      appointments: c._count.appointments,
      locations: c._count.locations,
      lastAppointment: c.appointments[0]?.startsAt.toISOString() ?? null,
    })),
  };
}

export async function getCustomer(user: CurrentUser, id: string) {
  assertCan(user, "customers.view");
  const c = await prisma.customer.findUnique({
    where: { id },
    include: { locations: { orderBy: { updatedAt: "desc" } } },
  });
  if (!c) throw new NotFoundError("Customer not found.");
  const contact = hasPermission(user, "customers.contact");
  const where = buildAppointmentWhere(user, {});
  const appts = await prisma.appointment.findMany({
    where: { AND: [where, { customerId: id }] },
    include: { status: true, createdBy: { select: { id: true, name: true, color: true, isActive: true } } },
    orderBy: { startsAt: "desc" },
    take: 100,
  });
  return {
    id: c.id,
    name: c.name,
    phone: contact ? c.phone : undefined,
    secondaryPhone: contact ? c.secondaryPhone : undefined,
    createdAt: c.createdAt.toISOString(),
    locations: hasPermission(user, "location.view") ? c.locations.map(locationDTO) : null,
    appointments: appts.map((a) => ({
      id: a.id,
      code: appointmentCode(a.number),
      startsAt: a.startsAt.toISOString(),
      endsAt: a.endsAt.toISOString(),
      status: { name: a.status.name, color: a.status.color, kind: a.status.kind },
      productCategory: a.productCategory,
      categoryOther: a.categoryOther,
      brand: a.brand,
      model: a.model,
      createdBy: a.createdBy,
    })),
  };
}
