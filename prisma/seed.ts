/**
 * Development seed data. Creates statuses, demo users (Admin, Sales, Technicians, Accountant,
 * Store keeper, Warehouse manager, Viewer), customers and ~2 months of non-overlapping appointments around today, with
 * prices, deposits and collections, plus serial-numbered stock (some installed with warranty) and a
 * small ERP inventory (products, the main store, Karim's van, an opening balance and a transfer).
 *
 *   npm run db:seed                 # only runs on an empty database
 *   SEED_FORCE=1 npm run db:seed    # wipes existing data first (never in production)
 *
 * All demo accounts use the password in SEED_PASSWORD (default "ChangeMe123!").
 */
import { PrismaClient, type PaymentMethod, type ProductCategory, type Role, type StatusKind, type VisitType } from "@prisma/client";
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

const STATUSES: { name: string; nameAr: string; kind: StatusKind; color: string; blocksSchedule: boolean; isDefault?: boolean }[] = [
  { name: "Scheduled", nameAr: "مجدول", kind: "SCHEDULED", color: "#2563EB", blocksSchedule: true, isDefault: true },
  { name: "In Progress", nameAr: "قيد التنفيذ", kind: "IN_PROGRESS", color: "#CA8A04", blocksSchedule: true },
  { name: "Completed", nameAr: "تم التنفيذ", kind: "COMPLETED", color: "#059669", blocksSchedule: true },
  { name: "Postponed/Rescheduled", nameAr: "مؤجل / ميعاد جديد", kind: "POSTPONED", color: "#7C3AED", blocksSchedule: true },
  { name: "Cancelled", nameAr: "ملغي", kind: "CANCELLED", color: "#6B7280", blocksSchedule: false },
  { name: "Unable to Complete", nameAr: "تعذّر التنفيذ", kind: "UNABLE_TO_COMPLETE", color: "#DC2626", blocksSchedule: true },
  { name: "Needs another visit", nameAr: "محتاج زيارة أخرى", kind: "NEEDS_REVISIT", color: "#EA580C", blocksSchedule: true },
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
  { name: "Nadia Fawzy", email: "nadia.accounts@example.com", role: "ACCOUNTANT", phone: "+20 100 444 5566" },
  { name: "Sameh Store", email: "store@example.com", role: "STORE", phone: "+20 100 555 6677" },
  { name: "Wael Warehouse", email: "warehouse@example.com", role: "WAREHOUSE_MANAGER", phone: "+20 100 777 8899" },
  { name: "Laila Viewer", email: "viewer@example.com", role: "VIEWER", viewerPermissions: ["appointments.view", "location.view", "reports.view"] },
  { name: "Tarek Driver", email: "driver@example.com", role: "DRIVER", phone: "+20 100 666 7788" },
];

// Prices follow the appointment counter (not rand()) so adding them did not change the rest of the data.
const PRICES = [3500, 4200, 5800, 2900, 7500, 1200, 6400, 4800];

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
      `TRUNCATE TABLE document_sequences, notifications, audit_logs, stock_movements, stock_items, product_models, cash_custody, technician_leaves, appointment_technicians, appointments, customer_locations, customers,
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
  const accountant = users.get("nadia.accounts@example.com")!.id;

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
        closedWeekdays: [5], // Friday
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
  const completedLocks: { id: string; day: string; tech: string; brand: string; model: string }[] = [];
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
      const totalPrice = PRICES[created % PRICES.length]!;
      const depositAmount = created % 3 === 0 ? null : Math.round((totalPrice * 0.3) / 100) * 100;
      const done = kind === "COMPLETED";
      // Most customers pay the rest at the visit; every fifth one still owes 500.
      const collectedAmount = done ? totalPrice - (depositAmount ?? 0) - (created % 5 === 0 ? 500 : 0) : null;
      const collectedMethod: PaymentMethod | null = collectedAmount ? (created % 4 === 0 ? "INSTAPAY" : "CASH") : null;
      const collectedAt = done ? endsAt : null;
      const appt = await prisma.appointment.create({
        data: {
          customerId: customer.id,
          locationId: pick(customer.locations),
          productCategory: product.category,
          visitType: pick<VisitType>(["INSTALLATION", "INSTALLATION", "INSTALLATION", "INSPECTION", "MAINTENANCE", "PROGRAMMING"]),
          customerConfirmation: offset < 0 || rand() < 0.6 ? "CONFIRMED" : "PENDING",
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
          totalPrice,
          depositAmount,
          depositMethod: depositAmount ? (created % 2 ? "CASH" : "BANK_TRANSFER") : null,
          collectedAmount,
          collectedMethod,
          collectedAt,
          collectedById: done ? team[0]! : null,
          statusId: statuses.get(kind)!,
          createdById: creator,
          updatedById: creator,
          technicians: {
            create: team.map((technicianId) => ({ technicianId, startsAt, endsAt, blocksSchedule: blocks, assignedById: creator })),
          },
        },
      });
      if (collectedMethod === "CASH" && collectedAmount && collectedAt) {
        // Cash from the last week is still with the technician; older cash was handed over.
        const handedOver = offset < -7;
        await prisma.cashCustody.create({
          data: {
            appointmentId: appt.id,
            technicianId: team[0]!,
            amount: collectedAmount,
            collectedAt,
            status: handedOver ? "RECEIVED" : "HELD",
            receivedById: handedOver ? accountant : null,
            receivedAt: handedOver ? new Date(collectedAt.getTime() + 2 * 86_400_000) : null,
          },
        });
      }
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
      if (kind === "COMPLETED" && product.category === "SMART_LOCK" && appt.model) {
        completedLocks.push({ id: appt.id, day, tech: team[0]!, brand: product.brand, model: appt.model });
      }
      created++;
    }
  }

  // Stock: every lock model in the catalogue, some locks installed on completed visits (with
  // warranty), some with technicians and the rest in the store. Serials follow a counter.
  const storeKeeper = users.get("store@example.com")!.id;
  const modelIds = new Map<string, string>();
  for (const p of PRODUCTS) {
    for (const m of p.models) {
      const row = await prisma.productModel.create({ data: { name: `${p.brand} ${m}`, category: p.category, warrantyMonths: p.category === "SMART_LOCK" ? 24 : 12 } });
      modelIds.set(`${p.brand} ${m}`, row.id);
    }
  }
  let serialNo = 1000;
  const addItem = async (name: string, state: { status: "IN_STORE" | "WITH_TECHNICIAN" | "INSTALLED"; holderId?: string; installer?: string; appointmentId?: string; day?: string }) => {
    const months = name.startsWith("Yale") || name.startsWith("Samsung") ? 24 : 12;
    const installedAt = state.day ? fromZonedTime(`${state.day}T18:00:00`, TZ) : null;
    const warrantyUntil = state.day ? new Date(Date.UTC(Number(state.day.slice(0, 4)) + months / 12, Number(state.day.slice(5, 7)) - 1, Number(state.day.slice(8, 10)))) : null;
    const item = await prisma.stockItem.create({
      data: {
        serial: `SN${++serialNo}`,
        modelId: modelIds.get(name)!,
        status: state.status,
        holderId: state.holderId ?? null,
        appointmentId: state.appointmentId ?? null,
        installedAt,
        warrantyUntil,
        createdById: storeKeeper,
      },
    });
    await prisma.stockMovement.create({ data: { itemId: item.id, toStatus: "IN_STORE", note: "Goods in (seed)", actorId: storeKeeper } });
    if (state.status !== "IN_STORE") {
      await prisma.stockMovement.create({ data: { itemId: item.id, fromStatus: "IN_STORE", toStatus: "WITH_TECHNICIAN", holderId: state.holderId ?? state.installer!, actorId: storeKeeper } });
    }
    if (state.status === "INSTALLED") {
      await prisma.stockMovement.create({ data: { itemId: item.id, fromStatus: "WITH_TECHNICIAN", toStatus: "INSTALLED", appointmentId: state.appointmentId!, actorId: state.installer! } });
    }
  };
  for (const c of completedLocks) {
    if (!modelIds.has(`${c.brand} ${c.model}`)) continue;
    await addItem(`${c.brand} ${c.model}`, { status: "INSTALLED", installer: c.tech, appointmentId: c.id, day: c.day });
  }
  for (const [i, tech] of techs.entries()) {
    for (const name of ["Yale Linus L2", "Samsung SHP-DP609"].slice(0, 1 + (i % 2))) await addItem(name, { status: "WITH_TECHNICIAN", holderId: tech });
  }
  for (const name of [...modelIds.keys()]) await addItem(name, { status: "IN_STORE" });

  await seedInventory(users.get("warehouse@example.com")!.id, users.get("karim.tech@example.com")!.id);

  console.log(`Seeded ${USERS.length} users, ${customers.length} customers and ${created} appointments.`);
  console.log(`Demo login: admin@example.com / ${password} (see README for all accounts)`);
}

/**
 * ERP inventory demo: catalogue, the main store with two bins, Karim's van (created here only
 * because this is demo data; real vehicles are added by hand), a posted opening balance and a
 * posted transfer to the van. Rows are written the way the posting engine writes them (draft
 * first, then posted; balances, movements and serial locations together).
 */
async function seedInventory(managerId: string, karimId: string) {
  const year = Number(dayKey(0).slice(0, 4));
  const docDate = new Date(`${dayKey(-7)}T00:00:00.000Z`);
  const cat = async (nameEn: string, nameAr: string, parentId: string | null = null, code: string | null = null) => (await prisma.catalogCategory.create({ data: { nameEn, nameAr, parentId, code } })).id;
  const locks = await cat("Smart locks", "أقفال ذكية", null, "LCK");
  const fingerprint = await cat("Fingerprint locks", "أقفال بصمة", locks);
  const smartHome = await cat("Smart home", "سمارت هوم", null, "SMH");
  const cctv = await cat("CCTV", "كاميرات مراقبة", null, "CAM");
  const cables = await cat("Cables & accessories", "كابلات وإكسسوارات");
  const brand = async (name: string) => (await prisma.brand.create({ data: { name } })).id;
  const [yale, aqara, hik] = [await brand("Yale"), await brand("Aqara"), await brand("Hikvision")];
  const products = [
    { sku: "YALE-L2", nameEn: "Yale Linus L2 smart lock", nameAr: "قفل ييل لينوس L2", categoryId: fingerprint, brandId: yale, model: "Linus L2", unitId: "unit-pcs", purchaseCost: 6500, sellingPrice: 8900, minStock: 3, warrantyMonths: 24, trackSerials: true, qty: 4 },
    { sku: "AQ-HUB-M3", nameEn: "Aqara Hub M3", nameAr: "هاب أكارا M3", categoryId: smartHome, brandId: aqara, model: "Hub M3", unitId: "unit-pcs", purchaseCost: 3200, sellingPrice: 4500, minStock: 2, warrantyMonths: 12, trackSerials: false, qty: 6 },
    { sku: "HIK-CAM-4", nameEn: "Hikvision ColorVu camera", nameAr: "كاميرا هيكفيجن كولورفيو", categoryId: cctv, brandId: hik, model: "DS-2CD2047G2", unitId: "unit-pcs", purchaseCost: 1800, sellingPrice: 2600, minStock: 8, warrantyMonths: 12, trackSerials: false, qty: 5 },
    { sku: "CBL-CAT6", nameEn: "Cat6 network cable", nameAr: "كابل شبكة Cat6", categoryId: cables, brandId: null, model: null, unitId: "unit-m", purchaseCost: 12, sellingPrice: 20, minStock: 300, warrantyMonths: 0, trackSerials: false, qty: 500 },
    { sku: "SCR-BOX-100", nameEn: "Wall plugs and screws (box of 100)", nameAr: "علبة خوابير ومسامير (100)", categoryId: cables, brandId: null, model: null, unitId: "unit-box", purchaseCost: 85, sellingPrice: 140, minStock: 5, warrantyMonths: 0, trackSerials: false, qty: 12 },
  ];
  const created: { id: string; sku: string; cost: number; qty: number; serials: string[] }[] = [];
  for (const { qty, ...p } of products) {
    const row = await prisma.product.create({ data: { ...p, averageCost: p.purchaseCost, createdById: managerId } });
    created.push({ id: row.id, sku: p.sku, cost: p.purchaseCost, qty, serials: p.trackSerials ? Array.from({ length: qty }, (_, i) => `YL2-${year}-${String(i + 1).padStart(4, "0")}`) : [] });
  }
  // A product with colour variants: stock is kept per colour (the product itself holds none).
  const shared = { categoryId: fingerprint, brandId: yale, model: "Model X", unitId: "unit-pcs", warrantyMonths: 24, trackSerials: true, createdById: managerId };
  const modelX = await prisma.product.create({ data: { ...shared, sku: "LCK-00001", nameEn: "Smart Lock Model X", nameAr: "قفل ذكي موديل X", purchaseCost: 4200, sellingPrice: 5900, hasVariants: true } });
  for (const [en, ar, color, qty] of [["Black", "أسود", "#1F1F1F", 2], ["Silver", "فضي", "#C0C0C0", 1], ["Gold", "ذهبي", "#C9A227", 0]] as const) {
    const v = await prisma.product.create({
      data: { ...shared, sku: `LCK-00001-${en.toUpperCase()}`, nameEn: `Smart Lock Model X - ${en}`, nameAr: `قفل ذكي موديل X - ${ar}`, parentId: modelX.id, variantNameEn: en, variantNameAr: ar, colorHex: color, purchaseCost: 4200, sellingPrice: 5900, averageCost: 4200, minStock: 1 },
    });
    if (qty) created.push({ id: v.id, sku: v.sku, cost: 4200, qty, serials: Array.from({ length: qty }, (_, i) => `SLX-${en.slice(0, 2).toUpperCase()}-${String(i + 1).padStart(3, "0")}`) });
  }
  const main = await prisma.warehouse.create({ data: { code: "MAIN", nameEn: "Main store", nameAr: "المخزن الرئيسي", kind: "WAREHOUSE", address: "Head office, New Cairo", createdById: managerId } });
  const binA = await prisma.warehouseBin.create({ data: { warehouseId: main.id, code: "A-01", name: "Locks shelf" } });
  await prisma.warehouseBin.create({ data: { warehouseId: main.id, code: "A-02", name: "Cables" } });
  const van = await prisma.warehouse.create({ data: { code: "VAN-KARIM", nameEn: "Karim's van", nameAr: "عربية كريم", kind: "VEHICLE", technicianId: karimId, createdById: managerId } });

  const balance = new Map<string, number>();
  const move = async (docId: string, lineId: string, type: "OPENING_BALANCE" | "TRANSFER_OUT" | "TRANSFER_IN", p: (typeof created)[number], warehouseId: string, binId: string | null, qty: number, serials: string[], from: string | null, to: string | null) => {
    const key = `${p.id}|${warehouseId}|${binId ?? ""}`;
    const after = (balance.get(key) ?? 0) + qty;
    balance.set(key, after);
    await prisma.stockBalance.upsert({
      where: { productId_warehouseId_binKey: { productId: p.id, warehouseId, binKey: binId ?? "" } },
      create: { productId: p.id, warehouseId, binId, binKey: binId ?? "", quantity: after },
      update: { quantity: after },
    });
    const m = await prisma.inventoryMovement.create({
      data: { documentId: docId, lineId, type, productId: p.id, warehouseId, binId, quantity: qty, fromWarehouseId: from, toWarehouseId: to, unitCost: p.cost, serials, balanceAfter: after, documentDate: docDate, createdById: managerId },
    });
    for (const serial of serials) {
      await prisma.productSerial.upsert({
        where: { productId_serial: { productId: p.id, serial } },
        create: { productId: p.id, serial, warehouseId: qty > 0 ? warehouseId : null, binId: qty > 0 ? binId : null, lastMovementId: m.id },
        update: { warehouseId: qty > 0 ? warehouseId : null, binId: qty > 0 ? binId : null, lastMovementId: m.id },
      });
    }
  };

  // Opening balance of the main store (the lock on its shelf, the rest without a bin).
  const opening = await prisma.stockDocument.create({ data: { number: `OB-${year}-000001`, type: "OPENING", toWarehouseId: main.id, documentDate: docDate, note: "Opening balance (demo data)", createdById: managerId } });
  for (const [i, p] of created.entries()) {
    const binId = p.serials.length ? binA.id : null;
    const line = await prisma.stockDocumentLine.create({ data: { documentId: opening.id, lineNo: i + 1, productId: p.id, quantity: p.qty, unitCost: p.cost, toBinId: binId, serials: p.serials } });
    await move(opening.id, line.id, "OPENING_BALANCE", p, main.id, binId, p.qty, p.serials, null, main.id);
  }
  await prisma.stockDocument.update({ where: { id: opening.id }, data: { status: "POSTED", postedAt: new Date(), postedById: managerId } });

  // Karim takes a lock, a hub and cable in his van.
  const transfer = await prisma.stockDocument.create({ data: { number: `TRF-${year}-000001`, type: "TRANSFER", fromWarehouseId: main.id, toWarehouseId: van.id, documentDate: docDate, reference: "Weekly van load", createdById: managerId } });
  const load: [string, number][] = [["YALE-L2", 1], ["AQ-HUB-M3", 2], ["CBL-CAT6", 100]];
  for (const [i, [sku, qty]] of load.entries()) {
    const p = created.find((x) => x.sku === sku)!;
    const serials = p.serials.slice(0, p.serials.length ? qty : 0);
    const fromBin = p.serials.length ? binA.id : null;
    const line = await prisma.stockDocumentLine.create({ data: { documentId: transfer.id, lineNo: i + 1, productId: p.id, quantity: qty, fromBinId: fromBin, serials } });
    await move(transfer.id, line.id, "TRANSFER_OUT", p, main.id, fromBin, -qty, serials, main.id, van.id);
    await move(transfer.id, line.id, "TRANSFER_IN", p, van.id, null, qty, serials, main.id, van.id);
  }
  await prisma.stockDocument.update({ where: { id: transfer.id }, data: { status: "POSTED", postedAt: new Date(), postedById: managerId } });
  // Later documents continue the numbering.
  await prisma.documentSequence.createMany({ data: [{ key: `OB-${year}`, lastNumber: 1 }, { key: `TRF-${year}`, lastNumber: 1 }, { key: "SKU:LCK", lastNumber: 1 }], skipDuplicates: true });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
