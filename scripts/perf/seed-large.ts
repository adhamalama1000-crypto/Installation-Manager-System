/**
 * Generates a LARGE, realistic data set for performance testing (about 2.5 years of history for a
 * busy installation company). It only ever INSERTS, and refuses to run unless:
 *   - the target database name ends in "_perf", and
 *   - that database has no appointments yet.
 * It never touches your real database.
 *
 *   createdb installation_manager_perf
 *   DATABASE_URL=".../installation_manager_perf" npx prisma migrate deploy
 *   DATABASE_URL=".../installation_manager_perf" npx tsx scripts/perf/seed-large.ts
 *
 * PERF_SCALE (default 1) multiplies the appointment density. All demo accounts use the password in
 * SEED_PASSWORD (default "ChangeMe123!"); logins match the normal seed (admin@example.com, ...).
 */
import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient, type ProductCategory, type Role, type StatusKind } from "@prisma/client";
import bcrypt from "bcryptjs";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

const prisma = new PrismaClient();
const TZ = "Africa/Cairo";
const SCALE = Number(process.env.PERF_SCALE ?? 1);

let state = 4242;
function rand() {
  state = (state * 1664525 + 1013904223) % 4294967296;
  return state / 4294967296;
}
const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;

const STATUSES: { name: string; kind: StatusKind; color: string; blocksSchedule: boolean; isDefault?: boolean }[] = [
  { name: "Scheduled", kind: "SCHEDULED", color: "#2563EB", blocksSchedule: true, isDefault: true },
  { name: "In Progress", kind: "IN_PROGRESS", color: "#CA8A04", blocksSchedule: true },
  { name: "Completed", kind: "COMPLETED", color: "#059669", blocksSchedule: true },
  { name: "Postponed/Rescheduled", kind: "POSTPONED", color: "#7C3AED", blocksSchedule: true },
  { name: "Cancelled", kind: "CANCELLED", color: "#6B7280", blocksSchedule: false },
  { name: "Unable to Complete", kind: "UNABLE_TO_COMPLETE", color: "#DC2626", blocksSchedule: true },
];
const FIRST = ["Ahmed", "Mohamed", "Nour", "Hana", "Tarek", "Dina", "Khaled", "Rania", "Sherif", "Yasmin", "Amr", "Salma", "Hossam", "Mariam", "Walid", "Farida", "Mostafa", "Aya", "Omar", "Laila"];
const LAST = ["El-Sayed", "Abdelrahman", "Fouad", "Zaki", "Mansour", "Ibrahim", "Gamal", "Shawky", "Lotfy", "Hamdy", "Saleh", "Naguib", "Rashad", "Kamel"];
const AREAS = [
  { area: "New Cairo", buildings: ["Mivida", "Hyde Park", "Eastown", "Mountain View iCity", "Fifth Square", "Lake View"] },
  { area: "Sheikh Zayed", buildings: ["Beverly Hills", "Allegria", "Zayed Dunes", "Karma Residence"] },
  { area: "Maadi", buildings: ["Degla Towers", "Sarayat El Maadi", "Maadi Grand Mall Residence"] },
  { area: "Zamalek", buildings: ["Nile View Residence", "Abu El Feda Building"] },
  { area: "6th of October", buildings: ["Palm Hills", "Dreamland", "Galleria Moon Valley", "O West"] },
  { area: "Heliopolis", buildings: ["Korba Plaza", "Merghany Residence"] },
  { area: "Nasr City", buildings: ["Zahraa Tower", "City Stars Residence"] },
  { area: "North Coast", buildings: ["Marassi", "Hacienda Bay", "Mountain View Ras El Hekma"] },
];
const PRODUCTS: { category: ProductCategory; brand: string; models: string[] }[] = [
  { category: "SMART_LOCK", brand: "Yale", models: ["Linus L2", "Assure Lock 2"] },
  { category: "SMART_LOCK", brand: "Samsung", models: ["SHP-DP609", "SHS-P718"] },
  { category: "SMART_HOME", brand: "Aqara", models: ["Hub M3 kit", "Smart Switch H1"] },
  { category: "SMART_HOME", brand: "Sonoff", models: ["ZBMINI-L2", "NSPanel Pro"] },
  { category: "CCTV", brand: "Hikvision", models: ["4-camera ColorVu kit", "8-channel NVR kit"] },
  { category: "CCTV", brand: "Dahua", models: ["WizSense 4-cam kit"] },
  { category: "INTERCOM", brand: "Akuvox", models: ["E12W", "C315"] },
  { category: "OTHER", brand: "Somfy", models: ["Glydea Ultra 60"] },
];
const SLOTS = [
  { start: "09:00", minutes: 120 },
  { start: "11:30", minutes: 90 },
  { start: "13:30", minutes: 180 },
  { start: "17:00", minutes: 120 },
];

function dayKey(offset: number) {
  const today = formatInTimeZone(new Date(), TZ, "yyyy-MM-dd");
  const [y, m, d] = today.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + offset)).toISOString().slice(0, 10);
}

async function insertChunks<T>(label: string, rows: T[], write: (chunk: T[]) => Promise<unknown>, size = 2000) {
  for (let i = 0; i < rows.length; i += size) await write(rows.slice(i, i + size));
  console.log(`  ${label}: ${rows.length}`);
}

async function main() {
  const dbName = new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, "");
  if (!dbName.endsWith("_perf")) throw new Error(`Refusing to run: database "${dbName}" does not end in "_perf".`);
  if ((await prisma.appointment.count()) > 0) throw new Error(`Refusing to run: "${dbName}" already has appointments.`);

  const passwordHash = await bcrypt.hash(process.env.SEED_PASSWORD || "ChangeMe123!", 12);
  const t0 = Date.now();

  const statusIds = new Map<StatusKind, string>();
  for (const [i, s] of STATUSES.entries()) {
    const row = await prisma.appointmentStatus.create({ data: { ...s, isDefault: s.isDefault ?? false, sortOrder: i * 10 } });
    statusIds.set(s.kind, row.id);
  }
  await prisma.setting.create({
    data: {
      key: "general",
      value: { timezone: TZ, weekStartsOn: 6, dayStartHour: 8, dayEndHour: 22, defaultDurationMinutes: 120, travelBufferMinutes: 0, salesCanViewReports: true, salesCanEditOthersAppointments: true, technicianCanSeeContacts: true },
    },
  });

  const COLORS = ["#E55823", "#2563EB", "#059669", "#7C3AED", "#A16207", "#0891B2", "#DB2777", "#65A30D"];
  const users: { id: string; name: string; email: string; role: Role; color: string | null; isActive: boolean; viewerPermissions: string[]; passwordHash: string }[] = [];
  const add = (name: string, email: string, role: Role, extra: Partial<(typeof users)[number]> = {}) =>
    users.push({ id: randomUUID(), name, email, role, color: null, isActive: true, viewerPermissions: [], passwordHash, ...extra });
  add("System Admin", "admin@example.com", "ADMIN", { color: "#7C3AED" });
  add("Sara Mahmoud", "sara.sales@example.com", "SALES", { color: COLORS[0] });
  for (let i = 1; i < 12; i++) add(`Sales ${i}`, `sales${i}@example.com`, "SALES", { color: COLORS[i % COLORS.length]! });
  add("Karim Fathy", "karim.tech@example.com", "TECHNICIAN");
  for (let i = 1; i < 40; i++) add(`Technician ${String(i).padStart(2, "0")}`, `tech${i}@example.com`, "TECHNICIAN", { isActive: i % 8 !== 0 });
  add("Laila Viewer", "viewer@example.com", "VIEWER", { viewerPermissions: ["appointments.view", "location.view", "reports.view"] });
  await prisma.user.createMany({ data: users });
  const admin = users[0]!.id;
  const sales = users.filter((u) => u.role === "SALES").map((u) => u.id);
  const techs = users.filter((u) => u.role === "TECHNICIAN");
  console.log(`  users: ${users.length}`);

  const customers: { id: string; name: string; phone: string; phoneDigits: string; secondaryPhone: string | null; secondaryPhoneDigits: string | null }[] = [];
  const locations: Prisma.CustomerLocationCreateManyInput[] = [];
  const locsByCustomer = new Map<string, string[]>();
  for (let i = 0; i < 30_000; i++) {
    const phone = `+20 1${pick(["0", "1", "2", "5"])}${String(10_000_000 + Math.floor(rand() * 89_999_999)).slice(0, 8)}`;
    const second = rand() < 0.25 ? `+20 2 ${String(20_000_000 + Math.floor(rand() * 9_999_999))}` : null;
    const id = randomUUID();
    customers.push({ id, name: `${pick(FIRST)} ${pick(LAST)} ${i}`, phone, phoneDigits: phone.replace(/\D/g, ""), secondaryPhone: second, secondaryPhoneDigits: second?.replace(/\D/g, "") ?? null });
    const ids: string[] = [];
    for (let j = 0; j < (rand() < 0.2 ? 2 : 1); j++) {
      const a = pick(AREAS);
      const hasMap = rand() < 0.85;
      const lid = randomUUID();
      locations.push({
        id: lid,
        customerId: id,
        area: a.area,
        building: pick(a.buildings),
        streetAddress: `${Math.floor(rand() * 120) + 1} Road ${Math.floor(rand() * 300)}`,
        apartment: String(Math.floor(rand() * 30) + 1),
        floor: String(Math.floor(rand() * 12)),
        accessInstructions: rand() < 0.4 ? "Call 15 minutes before arrival. Security gate needs ID." : null,
        mapUrl: hasMap ? `https://www.google.com/maps/search/?api=1&query=30.0${Math.floor(rand() * 9999)},31.2${Math.floor(rand() * 9999)}` : null,
      });
      ids.push(lid);
    }
    locsByCustomer.set(id, ids);
  }
  await insertChunks("customers", customers, (c) => prisma.customer.createMany({ data: c }));
  await insertChunks("customer_locations", locations, (c) => prisma.customerLocation.createMany({ data: c }));

  const appts: Prisma.AppointmentCreateManyInput[] = [];
  const assigns: Prisma.AppointmentTechnicianCreateManyInput[] = [];
  const audits: Prisma.AuditLogCreateManyInput[] = [];
  const notes: Prisma.NotificationCreateManyInput[] = [];
  let number = 0;
  for (let offset = -900; offset <= 60; offset++) {
    const day = dayKey(offset);
    if (new Date(`${day}T12:00:00Z`).getUTCDay() === 5) continue; // Friday off
    for (const slot of SLOTS) {
      // Split the technicians into crews of one or two: crews never overlap within a slot.
      const pool = techs.filter((t) => t.isActive || offset < -120);
      for (let i = 0; i < pool.length; ) {
        const size = rand() < 0.25 ? 2 : 1;
        const crew = pool.slice(i, i + size);
        i += size;
        if (rand() > 0.32 * SCALE) continue;
        const customer = pick(customers);
        const product = pick(PRODUCTS);
        const startsAt = fromZonedTime(`${day}T${slot.start}:00`, TZ);
        const endsAt = new Date(startsAt.getTime() + slot.minutes * 60_000);
        let kind: StatusKind;
        const r = rand();
        if (offset < -2) kind = r < 0.74 ? "COMPLETED" : r < 0.86 ? "CANCELLED" : r < 0.92 ? "UNABLE_TO_COMPLETE" : r < 0.96 ? "POSTPONED" : "SCHEDULED";
        else if (offset <= 0) kind = r < 0.5 ? "IN_PROGRESS" : "SCHEDULED";
        else kind = r < 0.86 ? "SCHEDULED" : r < 0.94 ? "POSTPONED" : "CANCELLED";
        const blocks = STATUSES.find((s) => s.kind === kind)!.blocksSchedule;
        const creator = rand() < 0.06 ? admin : pick(sales);
        const id = randomUUID();
        number++;
        const created = new Date(startsAt.getTime() - (2 + Math.floor(rand() * 20)) * 86_400_000);
        appts.push({
          id,
          number,
          customerId: customer.id,
          locationId: pick(locsByCustomer.get(customer.id)!),
          productCategory: product.category,
          categoryOther: product.category === "OTHER" ? "Motorised curtains" : null,
          brand: product.brand,
          model: pick(product.models),
          description: "Install, configure and hand over to the customer. Explain the app and warranty.",
          requiredEquipment: "Drill set, ladder, cable tester",
          additionalNotes: rand() < 0.3 ? "Customer prefers technicians to wear shoe covers." : null,
          internalNotes: rand() < 0.3 ? "Paid 50% deposit. Collect remaining balance after installation." : null,
          startsAt,
          endsAt,
          durationMinutes: slot.minutes,
          statusId: statusIds.get(kind)!,
          createdById: creator,
          updatedById: creator,
          createdAt: created,
          updatedAt: created,
        });
        for (const t of crew) {
          assigns.push({ appointmentId: id, technicianId: t.id, startsAt, endsAt, blocksSchedule: blocks, assignedById: creator, assignedAt: created });
          notes.push({ id: randomUUID(), userId: t.id, appointmentId: id, type: "ASSIGNED", message: `New assignment APT-${String(number).padStart(6, "0")}: ${customer.name}`, readAt: offset < -3 ? endsAt : null, createdAt: created });
        }
        audits.push({ id: randomUUID(), entityType: "APPOINTMENT", entityId: id, appointmentId: id, action: "APPOINTMENT_CREATED", summary: `Created APT-${String(number).padStart(6, "0")} for ${customer.name}`, changes: { brand: product.brand, status: kind }, actorId: creator, createdAt: created });
        if (kind !== "SCHEDULED") {
          audits.push({ id: randomUUID(), entityType: "APPOINTMENT", entityId: id, appointmentId: id, action: kind === "CANCELLED" ? "APPOINTMENT_CANCELLED" : "STATUS_CHANGED", summary: `Changed status of APT-${String(number).padStart(6, "0")} to ${kind}`, changes: { status: { from: "Scheduled", to: kind } }, actorId: creator, createdAt: new Date(Math.min(endsAt.getTime(), Date.now())) });
        }
        if (rand() < 0.3) {
          audits.push({ id: randomUUID(), entityType: "APPOINTMENT", entityId: id, appointmentId: id, action: "APPOINTMENT_UPDATED", summary: `Updated details of APT-${String(number).padStart(6, "0")}`, changes: { model: { from: "old", to: "new" } }, actorId: creator, createdAt: new Date(created.getTime() + 3_600_000) });
        }
      }
    }
  }
  await insertChunks("appointments", appts, (c) => prisma.appointment.createMany({ data: c }));
  await prisma.$executeRawUnsafe(`SELECT setval(pg_get_serial_sequence('appointments', 'number'), (SELECT MAX(number) FROM appointments))`);
  await insertChunks("appointment_technicians", assigns, (c) => prisma.appointmentTechnician.createMany({ data: c }));
  await insertChunks("audit_logs", audits, (c) => prisma.auditLog.createMany({ data: c }));
  await insertChunks("notifications", notes, (c) => prisma.notification.createMany({ data: c }));
  await prisma.$executeRawUnsafe("ANALYZE");
  console.log(`Done in ${Math.round((Date.now() - t0) / 1000)} s.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
