import { beforeAll, describe, expect, it } from "vitest";
import { Prisma, type ProductCategory, type User } from "@prisma/client";
import { buildAppointmentWhere, calendarAppointments, listAppointments, parseAppointmentFilters, type AppointmentFilters } from "@/server/services/appointments";
import { appointmentFilterSql } from "@/server/services/appointment-reads";
import { dashboardSummary } from "@/server/services/dashboard";
import { getCustomer, listCustomers } from "@/server/services/customers";
import { zonedToUtc } from "@/lib/time";
import { asCurrent, makeUser, prisma, resetDb, seedStatuses } from "../helpers";

/**
 * The list, calendar, dashboard and export reads use hand-written SQL (appointment-reads.ts) for
 * speed. These tests pin them to the Prisma implementation they replaced: same rows for every
 * user and filter, same order, same redaction.
 */

const TZ = "Africa/Cairo";
let statuses: Awaited<ReturnType<typeof seedStatuses>>;
let admin: User, sales1: User, sales2: User, tech1: User, tech2: User, viewerNone: User, viewerFull: User;
const ids: string[] = [];

async function customerWithSites(name: string, phone: string, secondaryPhone: string | null, sites: { area: string | null; building: string | null; streetAddress: string | null; mapUrl?: string | null }[]) {
  const c = await prisma.customer.create({
    data: { name, phone, phoneDigits: phone.replace(/\D/g, ""), secondaryPhone, secondaryPhoneDigits: secondaryPhone?.replace(/\D/g, "") ?? null },
  });
  const locs = [];
  for (const s of sites) locs.push(await prisma.customerLocation.create({ data: { customerId: c.id, ...s, mapUrl: s.mapUrl ?? null } }));
  return { id: c.id, locs: locs.map((l) => l.id) };
}

beforeAll(async () => {
  await resetDb();
  statuses = await seedStatuses();
  admin = await makeUser("ADMIN");
  sales1 = await makeUser("SALES", { color: "#E55823" });
  sales2 = await makeUser("SALES", { color: "#2563EB" });
  tech1 = await makeUser("TECHNICIAN", { name: "Tech One" });
  tech2 = await makeUser("TECHNICIAN", { name: "Tech Two" });
  viewerNone = await makeUser("VIEWER", { viewerPermissions: ["appointments.view"] });
  viewerFull = await makeUser("VIEWER", { viewerPermissions: ["appointments.view", "customers.view", "customers.contact", "location.view"] });

  const customers = [
    await customerWithSites("Ahmed Fouad", "+20 100 111 2233", "+20 2 2735 0000", [
      { area: "New Cairo", building: "Mivida", streetAddress: "90th Street", mapUrl: "https://maps.app.goo.gl/a" },
      { area: "Maadi", building: "Degla Towers", streetAddress: "Road 9" },
    ]),
    await customerWithSites("Mona 50% Discount", "01001234567", null, [{ area: "Zamalek", building: "Nile View", streetAddress: "Abu El Feda St" }]),
    await customerWithSites("Nour_Zaki", "+20 122 999 8888", null, [{ area: "Sheikh Zayed", building: "Allegria", streetAddress: null }]),
    await customerWithSites("Karim El-Sayed", "0155 000 1111", null, [{ area: null, building: null, streetAddress: "26th of July" }]),
    await customerWithSites("Mona 500 Offices", "0111 222 3333", null, [{ area: "Heliopolis", building: "Korba", streetAddress: "Road 90" }]),
  ];
  const products: { productCategory: ProductCategory; brand: string | null; model: string | null; categoryOther: string | null }[] = [
    { productCategory: "SMART_LOCK", brand: "Yale", model: "Linus L2", categoryOther: null },
    { productCategory: "CCTV", brand: "Hikvision", model: "ColorVu", categoryOther: null },
    { productCategory: "OTHER", brand: "Somfy", model: null, categoryOther: "Motorised curtains" },
    { productCategory: "INTERCOM", brand: null, model: "C315", categoryOther: null },
  ];
  const kinds = ["SCHEDULED", "COMPLETED", "CANCELLED", "POSTPONED", "IN_PROGRESS"] as const;
  for (let i = 0; i < 30; i++) {
    const c = customers[i % customers.length]!;
    const day = String(1 + ((i * 7) % 28)).padStart(2, "0");
    const startsAt = zonedToUtc(`2030-03-${day}`, `${String(8 + (i % 9)).padStart(2, "0")}:00`, TZ);
    const kind = kinds[i % kinds.length]!;
    const a = await prisma.appointment.create({
      data: {
        customerId: c.id,
        locationId: c.locs[i % c.locs.length]!,
        ...products[i % products.length]!,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 90 * 60_000),
        durationMinutes: 90,
        statusId: statuses[kind],
        createdById: i % 3 === 0 ? sales2.id : i % 7 === 0 ? admin.id : sales1.id,
        createdAt: new Date(Date.UTC(2030, 0, 1 + (i % 5))), // deliberate ties
      },
    });
    const crew = i % 4 === 0 ? [] : i % 4 === 1 ? [tech1.id] : i % 4 === 2 ? [tech2.id] : [tech1.id, tech2.id];
    for (const technicianId of crew) {
      await prisma.appointmentTechnician.create({
        data: { appointmentId: a.id, technicianId, startsAt: a.startsAt, endsAt: a.endsAt, blocksSchedule: false },
      });
    }
    ids.push(a.id);
  }
});

async function viaPrisma(user: User, f: Partial<AppointmentFilters>) {
  const rows = await prisma.appointment.findMany({ where: buildAppointmentWhere(asCurrent(user), f), select: { id: true } });
  return rows.map((r) => r.id).sort();
}
async function viaSql(user: User, f: Partial<AppointmentFilters>) {
  const rows = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT a.id FROM appointments a WHERE ${appointmentFilterSql(asCurrent(user), f)}`);
  return rows.map((r) => r.id).sort();
}

describe("appointment list SQL", () => {
  const users = () => [admin, sales1, tech1, tech2, viewerNone, viewerFull];
  const QUERIES = ["ahmed", "AHMED", "fouad", "0100", "2735", "0155", "1001", "apt-000003", "#5", "7", "yale", "LINUS", "curtain", "cairo", "mivida", "road", "Nile", "zz-no-match", "Mona", "50", "Discount"];

  it("returns the same appointments as the Prisma filter for every user and search", async () => {
    let checked = 0;
    for (const u of users()) {
      for (const q of ["", ...QUERIES]) {
        const f = { q: q || undefined };
        expect(await viaSql(u, f), `${u.role} q=${q}`).toEqual(await viaPrisma(u, f));
        checked++;
      }
    }
    expect(checked).toBe(6 * (QUERIES.length + 1));
  });

  it("returns the same appointments for combined filters", async () => {
    let state = 99;
    const rand = () => {
      state = (state * 1664525 + 1013904223) % 4294967296;
      return state / 4294967296;
    };
    const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;
    let nonEmpty = 0;
    for (let i = 0; i < 300; i++) {
      const f: Partial<AppointmentFilters> = {
        q: pick([undefined, undefined, ...QUERIES]),
        status: pick([undefined, [statuses.SCHEDULED], [statuses.COMPLETED, statuses.CANCELLED]]),
        category: pick([undefined, "SMART_LOCK", "OTHER"] as const),
        salesId: pick([undefined, sales1.id, sales2.id]),
        technicianId: pick([undefined, tech1.id, tech2.id]),
        area: pick([undefined, "cairo", "allegria", "Road"]),
        from: pick([undefined, "2030-03-05"]),
        to: pick([undefined, "2030-03-15"]),
      };
      const u = pick(users());
      const expected = await viaPrisma(u, f);
      if (expected.length) nonEmpty++;
      expect(await viaSql(u, f), JSON.stringify({ role: u.role, ...f })).toEqual(expected);
    }
    expect(nonEmpty).toBeGreaterThan(30); // the combinations must actually exercise matches
  });

  it("matches % and _ literally instead of as wildcards", async () => {
    const names = async (q: string) => {
      const r = await listAppointments(asCurrent(admin), parseAppointmentFilters({ q, pageSize: "200" }));
      return [...new Set(r.rows.map((x) => x.customerName))].sort();
    };
    expect(await names("50%")).toEqual(["Mona 50% Discount"]);
    expect(await names("nour_")).toEqual(["Nour_Zaki"]);
    expect(await names("r_z")).toEqual(["Nour_Zaki"]);
  });

  it("sorts and paginates like before", async () => {
    const user = asCurrent(sales1);
    const ref = async (orderBy: Prisma.AppointmentOrderByWithRelationInput[]) =>
      (await prisma.appointment.findMany({ orderBy, select: { id: true } })).map((r) => r.id);
    const list = async (sort: string, dir: string) =>
      (await listAppointments(user, parseAppointmentFilters({ sort, dir, pageSize: "200" }))).rows.map((r) => r.id);
    expect(await list("startsAt", "desc")).toEqual(await ref([{ startsAt: "desc" }, { number: "asc" }]));
    expect(await list("startsAt", "asc")).toEqual(await ref([{ startsAt: "asc" }, { number: "asc" }]));
    expect(await list("number", "desc")).toEqual(await ref([{ number: "desc" }]));
    expect(await list("customer", "asc")).toEqual(await ref([{ customer: { name: "asc" } }, { startsAt: "asc" }, { id: "asc" }]));
    expect(await list("createdAt", "desc")).toEqual(await ref([{ createdAt: "desc" }, { id: "asc" }]));

    const page2 = await listAppointments(user, parseAppointmentFilters({ page: "2", pageSize: "7" }));
    expect(page2.total).toBe(30);
    expect(page2.pageCount).toBe(5);
    expect(page2.rows.map((r) => r.id)).toEqual((await list("startsAt", "desc")).slice(7, 14));
  });

  it("builds list items with the same fields and redaction", async () => {
    const full = (await listAppointments(asCurrent(admin), parseAppointmentFilters({ q: "apt-000002" }))).rows[0]!;
    const a = await prisma.appointment.findFirstOrThrow({
      where: { number: 2 },
      include: { customer: true, location: true, status: true, createdBy: true, technicians: { include: { technician: true } } },
    });
    expect(full).toEqual({
      id: a.id,
      code: "APT-000002",
      startsAt: a.startsAt.toISOString(),
      endsAt: a.endsAt.toISOString(),
      durationMinutes: 90,
      customerName: a.customer.name,
      customerPhone: a.customer.phone,
      area: a.location.area,
      building: a.location.building,
      hasLocation: Boolean(a.location.mapUrl || a.location.latitude !== null),
      productCategory: a.productCategory,
      categoryOther: a.categoryOther,
      visitType: a.visitType,
      customerConfirmation: a.customerConfirmation,
      brand: a.brand,
      model: a.model,
      status: { id: a.status.id, name: a.status.name, kind: a.status.kind, color: a.status.color },
      createdBy: { id: a.createdBy.id, name: a.createdBy.name, color: a.createdBy.color, isActive: a.createdBy.isActive },
      technicians: a.technicians.map((t) => ({ id: t.technician.id, name: t.technician.name })).sort((x, y) => x.name.localeCompare(y.name)),
    });
    const limited = (await listAppointments(asCurrent(viewerNone), parseAppointmentFilters({ q: "apt-000002" }))).rows[0]!;
    expect(limited.id).toBe(a.id);
    for (const hidden of ["customerPhone", "area", "building", "hasLocation"]) expect(hidden in limited).toBe(false);
  });
});

describe("dashboard summary", () => {
  it("counts and flags exactly the expected appointments", async () => {
    await resetDb();
    const st = await seedStatuses();
    const boss = await makeUser("ADMIN");
    const t1 = await makeUser("TECHNICIAN");
    const t2 = await makeUser("TECHNICIAN");
    const withMap = await customerWithSites("With Map", "0100", null, [{ area: "A", building: "B", streetAddress: "C", mapUrl: "https://maps.app.goo.gl/x" }]);
    const noMap = await customerWithSites("No Map", "0101", null, [{ area: "A", building: "B", streetAddress: "C" }]);
    const make = async (n: number, day: string, time: string, minutes: number, kind: keyof typeof st, techs: string[], c = withMap) => {
      const startsAt = zonedToUtc(day, time, TZ);
      const a = await prisma.appointment.create({
        data: {
          customerId: c.id,
          locationId: c.locs[0]!,
          productCategory: "SMART_LOCK",
          startsAt,
          endsAt: new Date(startsAt.getTime() + minutes * 60_000),
          durationMinutes: minutes,
          statusId: st[kind],
          createdById: boss.id,
          number: n,
        },
      });
      for (const technicianId of techs) {
        await prisma.appointmentTechnician.create({ data: { appointmentId: a.id, technicianId, startsAt: a.startsAt, endsAt: a.endsAt, blocksSchedule: kind !== "CANCELLED" } });
      }
      return a.id;
    };
    const a1 = await make(1, "2030-03-10", "08:00", 60, "SCHEDULED", [t1.id]); // today, overdue
    const a2 = await make(2, "2030-03-10", "14:00", 120, "SCHEDULED", []); // today, upcoming, unassigned
    const a3 = await make(3, "2030-03-10", "18:00", 60, "CANCELLED", [t2.id]); // today but cancelled
    const a4 = await make(4, "2030-03-12", "10:00", 60, "POSTPONED", [t2.id], noMap); // no map location
    await make(5, "2030-03-02", "10:00", 60, "COMPLETED", [t2.id]); // completed this month
    await make(6, "2030-02-20", "10:00", 60, "COMPLETED", [t2.id]); // completed last month
    const a7 = await make(7, "2030-03-25", "10:00", 60, "SCHEDULED", [t1.id]); // upcoming, beyond a week
    const a8 = await make(8, "2030-03-09", "10:00", 120, "IN_PROGRESS", [t1.id]); // overdue
    const now = new Date("2030-03-10T10:00:00Z"); // 12:00 in Cairo

    const all = await dashboardSummary(asCurrent(boss), now);
    expect(all.today).toBe("2030-03-10");
    expect(all.counts).toEqual({ today: 2, upcoming: 3, scheduled: 3, completed: 1, postponed: 1, cancelled: 1, attention: 4 });
    expect(all.attention.map((x) => [x.id, x.reason])).toEqual([
      [a1, "dashboard.reasons.overdue"],
      [a8, "dashboard.reasons.overdue"],
      [a2, "dashboard.reasons.unassigned"],
      [a4, "dashboard.reasons.noLocation"],
    ]);
    expect(all.todays.map((x) => x.id)).toEqual([a1, a2, a3]);

    const tech = await dashboardSummary(asCurrent(t1), now);
    expect(tech.counts).toEqual({ today: 1, upcoming: 1, scheduled: 2, completed: 0, postponed: 0, cancelled: 0, attention: 2 });
    expect(tech.attention.map((x) => x.id)).toEqual([a1, a8]);
    expect(tech.todays.map((x) => x.id)).toEqual([a1]);
    void a7;
  });
});

describe("customers", () => {
  it("lists customers with their figures, newest first, and searches by permitted fields", async () => {
    await resetDb();
    const st = await seedStatuses();
    const boss = await makeUser("ADMIN");
    const viewer = await makeUser("VIEWER", { viewerPermissions: ["customers.view"] });
    const older = await customerWithSites("Older Customer", "+20 100 555 0001", null, [{ area: "Maadi", building: "Degla", streetAddress: "Road 9" }]);
    const newer = await customerWithSites("Newer Customer", "+20 100 555 0002", null, [
      { area: "Zamalek", building: "Nile", streetAddress: "Abu El Feda" },
      { area: "New Cairo", building: "Mivida", streetAddress: "90th" },
    ]);
    await prisma.customer.update({ where: { id: older.id }, data: { updatedAt: new Date("2030-01-01T00:00:00Z") } });
    await prisma.customer.update({ where: { id: newer.id }, data: { updatedAt: new Date("2030-02-01T00:00:00Z") } });
    await prisma.customerLocation.update({ where: { id: newer.locs[1]! }, data: { updatedAt: new Date("2030-02-02T00:00:00Z") } });
    await prisma.customerLocation.update({ where: { id: newer.locs[0]! }, data: { updatedAt: new Date("2030-01-15T00:00:00Z") } });
    for (const [i, day] of ["2030-03-01", "2030-03-20"].entries()) {
      const startsAt = zonedToUtc(day, "10:00", TZ);
      await prisma.appointment.create({
        data: { customerId: newer.id, locationId: newer.locs[i]!, productCategory: "CCTV", startsAt, endsAt: new Date(startsAt.getTime() + 3_600_000), durationMinutes: 60, statusId: st.SCHEDULED, createdById: boss.id },
      });
    }

    const list = await listCustomers(asCurrent(boss), {});
    expect(list.total).toBe(2);
    expect(list.rows).toEqual([
      { id: newer.id, name: "Newer Customer", phone: "+20 100 555 0002", area: "New Cairo", appointments: 2, locations: 2, lastAppointment: zonedToUtc("2030-03-20", "10:00", TZ).toISOString() },
      { id: older.id, name: "Older Customer", phone: "+20 100 555 0001", area: "Maadi", appointments: 0, locations: 1, lastAppointment: null },
    ]);
    const names = async (user: User, q: string) => (await listCustomers(asCurrent(user), { q })).rows.map((r) => r.name);
    expect(await names(boss, "newer")).toEqual(["Newer Customer"]);
    expect(await names(boss, "5550001")).toEqual(["Older Customer"]);
    expect(await names(boss, "mivida")).toEqual(["Newer Customer"]);
    expect(await names(boss, "customer")).toEqual(["Newer Customer", "Older Customer"]);
    // A viewer without phone/address permission cannot search by them, and does not see them.
    expect(await names(viewer, "5550001")).toEqual([]);
    expect(await names(viewer, "mivida")).toEqual([]);
    const v = await listCustomers(asCurrent(viewer), {});
    expect(v.rows[0]!.phone).toBeUndefined();
    expect(v.rows[0]!.area).toBeUndefined();
    const paged = await listCustomers(asCurrent(boss), { page: 2, pageSize: 1 });
    expect(paged.rows.map((r) => r.id)).toEqual([older.id]);
    expect(paged.pageCount).toBe(2);

    const detail = await getCustomer(asCurrent(boss), newer.id);
    expect(detail.appointments.map((a) => a.startsAt)).toEqual([zonedToUtc("2030-03-20", "10:00", TZ).toISOString(), zonedToUtc("2030-03-01", "10:00", TZ).toISOString()]);
    expect(detail.locations?.length).toBe(2);
    // customers.view without appointments.view: the customer, but none of the appointments.
    expect((await getCustomer(asCurrent(viewer), newer.id)).appointments).toEqual([]);
  });
});

describe("calendar range", () => {
  it("includes appointments that started the day before and run into the range (up to 24 hours long)", async () => {
    await resetDb();
    const st = await seedStatuses();
    const boss = await makeUser("ADMIN");
    const c = await customerWithSites("Night Owl", "0100", null, [{ area: "A", building: "B", streetAddress: "C" }]);
    const make = async (day: string, time: string, minutes: number) => {
      const startsAt = zonedToUtc(day, time, TZ);
      return (
        await prisma.appointment.create({
          data: { customerId: c.id, locationId: c.locs[0]!, productCategory: "CCTV", startsAt, endsAt: new Date(startsAt.getTime() + minutes * 60_000), durationMinutes: minutes, statusId: st.SCHEDULED, createdById: boss.id },
        })
      ).id;
    };
    const overnight = await make("2030-04-30", "23:00", 120); // ends 01:00 on 1 May
    const fullDay = await make("2030-04-30", "00:30", 1440); // ends 00:30 on 1 May
    await make("2030-04-29", "10:00", 60); // entirely before
    await make("2030-04-30", "22:00", 120); // ends exactly at midnight: not in 1 May
    const inside = await make("2030-05-01", "10:00", 60);
    const ids = (await calendarAppointments(asCurrent(boss), { from: "2030-05-01", to: "2030-05-01" })).map((a) => a.id);
    expect(ids).toEqual([fullDay, overnight, inside]);
  });
});
