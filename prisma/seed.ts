/**
 * Development seed data. Creates statuses, demo users (Admin, Sales, Technicians, Viewer),
 * customers and ~2 months of non-overlapping appointments around today.
 *
 *   npm run db:seed                 # only runs on an empty database
 *   SEED_FORCE=1 npm run db:seed    # wipes existing data first (never in production)
 *
 * All demo accounts use the password in SEED_PASSWORD (default "ChangeMe123!").
 */
import { PrismaClient, type ProductCategory, type Role, type StatusKind } from "@prisma/client";
import bcrypt from "bcryptjs";
import { fromZonedTime, formatInTimeZone } from "date-fns-tz";

const prisma = new PrismaClient();
const TZ = "Africa/Cairo";

// Deterministic pseudo-random generator so every seed run produces the same data.
let state = 20261025;
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

const USERS: { name: string; email: string; role: Role; color?: string; isActive?: boolean; phone?: string; viewerPermissions?: string[] }[] = [
  { name: "System Admin", email: "admin@example.com", role: "ADMIN", color: "#7C3AED" },
  { name: "Sara Mahmoud", email: "sara.sales@example.com", role: "SALES", color: "#E55823", phone: "+20 100 111 2233" },
  { name: "Omar Hassan", email: "omar.sales@example.com", role: "SALES", color: "#2563EB", phone: "+20 100 222 3344" },
  { name: "Mona Adel", email: "mona.sales@example.com", role: "SALES", color: "#059669", phone: "+20 100 333 4455" },
  { name: "Karim Fathy", email: "karim.tech@example.com", role: "TECHNICIAN", phone: "+20 111 000 1111" },
  { name: "Youssef Nabil", email: "youssef.tech@example.com", role: "TECHNICIAN", phone: "+20 111 000 2222" },
  { name: "Ahmed Samir", email: "ahmed.tech@example.com", role: "TECHNICIAN", phone: "+20 111 000 3333" },
  { name: "Mostafa Ali", email: "mostafa.tech@example.com", role: "TECHNICIAN", phone: "+20 111 000 4444" },
  { name: "Hany Saeed", email: "hany.tech@example.com", role: "TECHNICIAN", isActive: false },
  { name: "Laila Viewer", email: "viewer@example.com", role: "VIEWER", viewerPermissions: ["appointments.view", "location.view", "reports.view"] },
];

const FIRST = ["Ahmed", "Mohamed", "Nour", "Hana", "Tarek", "Dina", "Khaled", "Rania", "Sherif", "Yasmin", "Amr", "Salma", "Hossam", "Mariam", "Walid", "Farida"];
const LAST = ["El-Sayed", "Abdelrahman", "Fouad", "Zaki", "Mansour", "Ibrahim", "Gamal", "Shawky", "Lotfy", "Hamdy"];
const AREAS = [
  { area: "New Cairo", buildings: ["Mivida", "Hyde Park", "Eastown", "Mountain View iCity"], lat: 30.0074, lng: 31.4913 },
  { area: "Sheikh Zayed", buildings: ["Beverly Hills", "Allegria", "Zayed Dunes"], lat: 30.0444, lng: 30.9758 },
  { area: "Maadi", buildings: ["Degla Towers", "Sarayat El Maadi"], lat: 29.9602, lng: 31.2569 },
  { area: "Zamalek", buildings: ["Nile View Residence", "Abu El Feda Building"], lat: 30.0609, lng: 31.2197 },
  { area: "6th of October", buildings: ["Palm Hills", "Dreamland", "Galleria Moon Valley"], lat: 29.9668, lng: 30.9418 },
  { area: "Heliopolis", buildings: ["Korba Plaza", "Merghany Residence"], lat: 30.0911, lng: 31.3226 },
];
const STREETS = ["90th Street", "Road 9", "El Nasr Road", "Gamal Abdel Nasser St.", "Teseen St.", "Mohamed Mazhar St.", "26th of July Corridor"];
const PRODUCTS: { category: ProductCategory; brand: string; models: string[]; desc: string; equipment: string }[] = [
  { category: "SMART_LOCK", brand: "Yale", models: ["Linus L2", "Assure Lock 2"], desc: "Install smart lock on main door, pair with app and add family fingerprints.", equipment: "Drill set, door template, batteries" },
  { category: "SMART_LOCK", brand: "Samsung", models: ["SHP-DP609", "SHS-P718"], desc: "Replace existing lock with push-pull smart lock.", equipment: "Mortise kit, screwdriver set" },
  { category: "SMART_HOME", brand: "Aqara", models: ["Hub M3 kit", "Smart Switch H1"], desc: "Smart switches in living room and bedrooms, configure scenes.", equipment: "Neutral-wire tester, hub, ladder" },
  { category: "SMART_HOME", brand: "Sonoff", models: ["ZBMINI-L2", "NSPanel Pro"], desc: "Wall panel installation and lighting automation.", equipment: "Wall box, cables, ladder" },
  { category: "CCTV", brand: "Hikvision", models: ["4-camera ColorVu kit", "8-channel NVR kit"], desc: "Outdoor cameras at entrance and garden, NVR in storage room, remote viewing setup.", equipment: "Cat6 cable, PoE switch, ladder, drill" },
  { category: "CCTV", brand: "Dahua", models: ["WizSense 4-cam kit"], desc: "Replace old analogue cameras with IP cameras.", equipment: "Cable tester, crimping tool" },
  { category: "INTERCOM", brand: "Akuvox", models: ["E12W", "C315"], desc: "Video intercom at villa gate with indoor monitor.", equipment: "2-wire cable, gate bracket" },
  { category: "INTERCOM", brand: "Commax", models: ["CDV-70H2"], desc: "Apartment video door phone replacement.", equipment: "Mounting plate, screws" },
  { category: "OTHER", brand: "Somfy", models: ["Glydea Ultra 60"], desc: "Motorised curtain track installation.", equipment: "Curtain track, anchors" },
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

async function main() {
  if (process.env.NODE_ENV === "production" && process.env.SEED_ALLOW_PRODUCTION !== "1") {
    throw new Error("Refusing to seed demo data in production. Use `npm run create-admin` instead.");
  }
  const existingUsers = await prisma.user.count();
  if (existingUsers > 0) {
    if (process.env.SEED_FORCE !== "1") {
      console.log(`Database already has ${existingUsers} users - skipping seed. Run with SEED_FORCE=1 to wipe and reseed.`);
      return;
    }
    console.log("SEED_FORCE=1: wiping existing data...");
    // TRUNCATE does not fire the row-level trigger that protects audit_logs.
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE notifications, audit_logs, appointment_technicians, appointments, customer_locations, customers,
        password_tokens, sessions, login_attempts, settings, appointment_statuses, users RESTART IDENTITY CASCADE`,
    );
  }

  const password = process.env.SEED_PASSWORD || "ChangeMe123!";
  const passwordHash = await bcrypt.hash(password, 12);

  const statuses = new Map<StatusKind, string>();
  for (const [i, s] of STATUSES.entries()) {
    const row = await prisma.appointmentStatus.create({ data: { ...s, isDefault: s.isDefault ?? false, sortOrder: i * 10 } });
    statuses.set(s.kind, row.id);
  }

  const users = new Map<string, { id: string; role: Role; isActive: boolean }>();
  for (const u of USERS) {
    const row = await prisma.user.create({
      data: {
        name: u.name,
        email: u.email,
        role: u.role,
        phone: u.phone ?? null,
        color: u.color ?? null,
        isActive: u.isActive ?? true,
        viewerPermissions: u.viewerPermissions ?? [],
        passwordHash,
        passwordChangedAt: new Date(),
      },
    });
    users.set(u.email, { id: row.id, role: row.role, isActive: row.isActive });
  }
  const admin = users.get("admin@example.com")!.id;
  const sales = [...users.values()].filter((u) => u.role === "SALES").map((u) => u.id);
  const techs = [...users.values()].filter((u) => u.role === "TECHNICIAN" && u.isActive).map((u) => u.id);
  const inactiveTech = users.get("hany.tech@example.com")!.id;

  await prisma.setting.create({
    data: {
      key: "general",
      value: {
        timezone: TZ,
        weekStartsOn: 6,
        dayStartHour: 8,
        dayEndHour: 22,
        defaultDurationMinutes: 120,
        travelBufferMinutes: 0,
        salesCanViewReports: true,
        salesCanEditOthersAppointments: true,
        technicianCanSeeContacts: true,
      },
    },
  });

  // Customers with one or two installation sites each.
  const customers: { id: string; locations: string[]; name: string }[] = [];
  for (let i = 0; i < 26; i++) {
    const name = `${pick(FIRST)} ${pick(LAST)}`;
    const phone = `+20 1${pick(["0", "1", "2", "5"])}${String(10000000 + Math.floor(rand() * 89999999)).slice(0, 8)}`;
    const c = await prisma.customer.create({
      data: {
        name,
        phone,
        phoneDigits: phone.replace(/\D/g, ""),
        secondaryPhone: rand() < 0.3 ? "+20 2 2735 0000" : null,
        secondaryPhoneDigits: null,
      },
    });
    if (c.secondaryPhone) await prisma.customer.update({ where: { id: c.id }, data: { secondaryPhoneDigits: c.secondaryPhone.replace(/\D/g, "") } });
    const locCount = rand() < 0.2 ? 2 : 1;
    const locations: string[] = [];
    for (let j = 0; j < locCount; j++) {
      const a = pick(AREAS);
      const lat = +(a.lat + (rand() - 0.5) * 0.02).toFixed(6);
      const lng = +(a.lng + (rand() - 0.5) * 0.02).toFixed(6);
      const hasMap = rand() < 0.85;
      const loc = await prisma.customerLocation.create({
        data: {
          customerId: c.id,
          area: a.area,
          building: pick(a.buildings),
          streetAddress: `${Math.floor(rand() * 120) + 1} ${pick(STREETS)}`,
          apartment: String(Math.floor(rand() * 30) + 1),
          floor: String(Math.floor(rand() * 12)),
          accessInstructions: rand() < 0.4 ? "Call the customer 15 minutes before arrival. Security gate needs ID." : null,
          mapUrl: hasMap ? `https://www.google.com/maps/search/?api=1&query=${lat},${lng}` : null,
          latitude: hasMap ? lat : null,
          longitude: hasMap ? lng : null,
        },
      });
      locations.push(loc.id);
    }
    customers.push({ id: c.id, locations, name });
  }

  // Appointments from 21 days ago to 24 days ahead, never overlapping per technician.
  let created = 0;
  for (let offset = -21; offset <= 24; offset++) {
    const day = dayKey(offset);
    const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
    if (weekday === 5) continue; // Friday off
    for (const slot of SLOTS) {
      if (rand() < 0.35) continue;
      const free = techs.filter(() => rand() < 0.5);
      if (!free.length) continue;
      const crew = free.slice(0, rand() < 0.3 ? 2 : 1);
      const customer = pick(customers);
      const product = pick(PRODUCTS);
      const startsAt = fromZonedTime(`${day}T${slot.start}:00`, TZ);
      const endsAt = new Date(startsAt.getTime() + slot.minutes * 60000);
      let kind: StatusKind = "SCHEDULED";
      if (offset < 0) {
        const r = rand();
        kind = r < 0.72 ? "COMPLETED" : r < 0.84 ? "CANCELLED" : r < 0.9 ? "UNABLE_TO_COMPLETE" : "SCHEDULED"; // some overdue
      } else if (offset === 0) {
        kind = slot.start < "12:00" ? "IN_PROGRESS" : "SCHEDULED";
      } else {
        const r = rand();
        kind = r < 0.86 ? "SCHEDULED" : r < 0.94 ? "POSTPONED" : "CANCELLED";
      }
      const blocks = STATUSES.find((s) => s.kind === kind)!.blocksSchedule;
      // A seed appointment in the past may keep a now-inactive technician (historical reference).
      const team = offset < -7 && rand() < 0.15 ? [inactiveTech] : crew;
      const creator = rand() < 0.08 ? admin : pick(sales);
      const appt = await prisma.appointment.create({
        data: {
          customerId: customer.id,
          locationId: pick(customer.locations),
          productCategory: product.category,
          categoryOther: product.category === "OTHER" ? "Motorised curtains" : null,
          brand: product.brand,
          model: pick(product.models),
          description: product.desc,
          requiredEquipment: product.equipment,
          additionalNotes: rand() < 0.3 ? "Customer prefers technicians to wear shoe covers." : null,
          internalNotes: rand() < 0.3 ? "Paid 50% deposit. Collect remaining balance after installation." : null,
          startsAt,
          endsAt,
          durationMinutes: slot.minutes,
          statusId: statuses.get(kind)!,
          createdById: creator,
          updatedById: creator,
          technicians: {
            create: team.map((technicianId) => ({ technicianId, startsAt, endsAt, blocksSchedule: blocks, assignedById: creator })),
          },
        },
      });
      await prisma.auditLog.create({
        data: {
          entityType: "APPOINTMENT",
          entityId: appt.id,
          appointmentId: appt.id,
          action: "APPOINTMENT_CREATED",
          summary: `Created APT-${String(appt.number).padStart(6, "0")} for ${customer.name} (seed data)`,
          actorId: creator,
        },
      });
      created++;
    }
  }

  console.log(`Seeded ${USERS.length} users, ${customers.length} customers and ${created} appointments.`);
  console.log(`Demo login: admin@example.com / ${password} (see README for all accounts)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
