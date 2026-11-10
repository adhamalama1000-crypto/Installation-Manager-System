/**
 * Adds a LARGE ERP inventory to a performance database: about 3,000 products (some serial
 * tracked), 4 warehouses and 20 technicians' vans with bins, and roughly 40,000 ledger movements
 * from posted opening balances, transfers and issues, with consistent balances and serial
 * locations. Run it after scripts/perf/seed-large.ts. It only INSERTS and refuses to run unless
 * the database name ends in "_perf" and the database has no products yet.
 *
 *   DATABASE_URL=".../installation_manager_perf" npx tsx scripts/perf/seed-inventory.ts
 */
import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const PRODUCTS = Number(process.env.PERF_PRODUCTS ?? 3000);

let state = 777;
function rand() {
  state = (state * 1664525 + 1013904223) % 4294967296;
  return state / 4294967296;
}
const int = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;

const CATS: [string, string, string[]][] = [
  ["Smart locks", "الأقفال الذكية", ["Door locks", "Padlocks", "Lock accessories"]],
  ["Smart home", "المنزل الذكي", ["Switches", "Sensors", "Hubs"]],
  ["CCTV", "كاميرات المراقبة", ["Cameras", "Recorders", "Storage"]],
  ["Intercom", "الإنتركم", ["Indoor units", "Door stations"]],
  ["Access control", "التحكم في الدخول", ["RFID readers", "Cards & tags", "Turnstiles"]],
  ["Low current", "التيار الخفيف", ["Cables", "Connectors", "Power supplies"]],
];
const BRANDS = ["Yale", "Samsung", "Aqara", "Sonoff", "Hikvision", "Dahua", "Akuvox", "Somfy", "ZKTeco", "Ezviz", "TP-Link", "Ubiquiti", "Legrand", "Schneider", "Tuya", "Philips Hue", "Bosch", "Honeywell", "Nedap", "HID", "Uniview", "Imou", "Fanvil", "Commax", "Lutron"];

async function main() {
  const db = (await prisma.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`)[0]!.name;
  if (!db.endsWith("_perf")) throw new Error(`Refusing to run on "${db}": the database name must end in _perf.`);
  if ((await prisma.product.count()) > 0) throw new Error("This database already has products.");
  const t0 = Date.now();
  const admin = await prisma.user.findFirstOrThrow({ where: { role: "ADMIN" }, select: { id: true } });
  const techs = await prisma.user.findMany({ where: { role: "TECHNICIAN", isActive: true }, select: { id: true, name: true }, take: 20, orderBy: { email: "asc" } });

  // Catalogue.
  const subIds: string[] = [];
  for (const [i, [en, ar, subs]] of CATS.entries()) {
    const top = await prisma.catalogCategory.create({ data: { nameEn: en, nameAr: ar, sortOrder: i } });
    for (const [j, s] of subs.entries()) subIds.push((await prisma.catalogCategory.create({ data: { nameEn: s, nameAr: `${ar} - ${s}`, parentId: top.id, sortOrder: j } })).id);
  }
  const brandIds: string[] = [];
  for (const b of BRANDS) brandIds.push((await prisma.brand.create({ data: { name: b } })).id);

  type P = { id: string; sku: string; serial: boolean; cost: number; fraction: boolean };
  const products: P[] = [];
  const rows: Prisma.ProductCreateManyInput[] = [];
  for (let i = 1; i <= PRODUCTS; i++) {
    const serial = i % 7 === 0;
    const fraction = !serial && i % 23 === 0;
    const cost = int(20, 9000);
    const p: P = { id: randomUUID(), sku: `PRF-${String(i).padStart(5, "0")}`, serial, cost, fraction };
    products.push(p);
    const brand = pick(BRANDS);
    rows.push({
      id: p.id,
      sku: p.sku,
      barcode: i % 3 === 0 ? `62${String(1000000000 + i)}` : null,
      nameEn: `${brand} ${pick(["Pro", "Lite", "Max", "Mini", "Plus", "X"])} ${pick(["lock", "camera", "switch", "sensor", "reader", "cable", "panel", "hub"])} ${i}`,
      nameAr: `${pick(["قفل", "كاميرا", "مفتاح", "حساس", "قارئ", "كابل", "شاشة", "وحدة"])} ${brand} ${i}`,
      categoryId: pick(subIds),
      brandId: brandIds[BRANDS.indexOf(brand)]!,
      model: `M-${int(100, 999)}`,
      unitId: fraction ? "unit-m" : "unit-pcs",
      purchaseCost: new Prisma.Decimal(cost),
      sellingPrice: new Prisma.Decimal(Math.round(cost * 1.35)),
      averageCost: new Prisma.Decimal(cost),
      minStock: new Prisma.Decimal(int(0, 3) * 5),
      warrantyMonths: serial ? 24 : 0,
      trackSerials: serial,
      createdById: admin.id,
      createdAt: new Date(Date.now() - int(1, 900) * 86_400_000),
    });
  }
  for (let i = 0; i < rows.length; i += 1000) await prisma.product.createMany({ data: rows.slice(i, i + 1000) });

  // Warehouses, vans and bins.
  type W = { id: string; code: string; bins: string[] };
  const warehouses: W[] = [];
  for (const [code, en, ar] of [["MAIN", "Main store", "المخزن الرئيسي"], ["NORTH", "North store", "مخزن الشمال"], ["SOUTH", "South store", "مخزن الجنوب"], ["RETURNS", "Returns", "المرتجعات"]] as const) {
    const w = await prisma.warehouse.create({ data: { code, nameEn: en, nameAr: ar, createdById: admin.id } });
    const bins: string[] = [];
    for (let b = 1; b <= 30; b++) bins.push((await prisma.warehouseBin.create({ data: { warehouseId: w.id, code: `${String.fromCharCode(65 + Math.floor((b - 1) / 10))}-${String(((b - 1) % 10) + 1).padStart(2, "0")}` } })).id);
    warehouses.push({ id: w.id, code, bins });
  }
  const vans: W[] = [];
  for (const [i, t] of techs.entries()) {
    const w = await prisma.warehouse.create({ data: { code: `VAN-${String(i + 1).padStart(2, "0")}`, nameEn: `Van ${t.name}`, nameAr: `عربية ${t.name}`, kind: "VEHICLE", technicianId: t.id, createdById: admin.id } });
    vans.push({ id: w.id, code: w.code, bins: [] });
  }

  // Simulate the ledger in memory so balances, balanceAfter and serial locations agree.
  const loc = new Map<string, number>(); // product|warehouse|bin
  const wh = new Map<string, number>(); // product|warehouse
  const serialAt = new Map<string, { w: string | null; b: string | null; m: string }>(); // product|serial
  const serialsAt = new Map<string, string[]>(); // product|warehouse|bin -> serials there
  const docs: Prisma.StockDocumentCreateManyInput[] = [];
  const lines: Prisma.StockDocumentLineCreateManyInput[] = [];
  const moves: Prisma.InventoryMovementCreateManyInput[] = [];
  const seq = new Map<string, number>();
  let mseq = 0;
  const docNo = (prefix: string, year: number) => {
    const k = `${prefix}-${year}`;
    const n = (seq.get(k) ?? 0) + 1;
    seq.set(k, n);
    return `${k}-${String(n).padStart(6, "0")}`;
  };
  const move = (doc: { id: string; from: string | null; to: string | null; date: Date; at: Date }, lineId: string, type: Prisma.InventoryMovementCreateManyInput["type"], p: P, w: string, bin: string | null, qty: number, serials: string[]) => {
    const lk = `${p.id}|${w}|${bin ?? ""}`;
    loc.set(lk, (loc.get(lk) ?? 0) + qty);
    const wk = `${p.id}|${w}`;
    const after = (wh.get(wk) ?? 0) + qty;
    wh.set(wk, after);
    const id = `${doc.at.getTime().toString(36).padStart(9, "0")}-${String(mseq++ % 10000).padStart(4, "0")}-${randomUUID().slice(0, 13)}`;
    for (const s of serials) serialAt.set(`${p.id}|${s}`, { w: qty > 0 ? w : null, b: qty > 0 ? bin : null, m: id });
    moves.push({ id, documentId: doc.id, lineId, type, productId: p.id, warehouseId: w, binId: bin, quantity: new Prisma.Decimal(qty), fromWarehouseId: doc.from, toWarehouseId: doc.to, unitCost: new Prisma.Decimal(p.cost), serials, balanceAfter: new Prisma.Decimal(after), documentDate: doc.date, createdById: admin.id, createdAt: doc.at });
  };
  const takeSerials = (p: P, w: string, bin: string | null, n: number) => {
    const k = `${p.id}|${w}|${bin ?? ""}`;
    const list = serialsAt.get(k) ?? [];
    const out = list.splice(0, n);
    serialsAt.set(k, list);
    return out;
  };
  const putSerials = (p: P, w: string, bin: string | null, s: string[]) => {
    const k = `${p.id}|${w}|${bin ?? ""}`;
    serialsAt.set(k, [...(serialsAt.get(k) ?? []), ...s]);
  };
  const start = Date.now() - 400 * 86_400_000;
  let clock = start;
  const nextAt = () => new Date((clock += int(5, 40) * 60_000));
  const day = (d: Date) => new Date(`${d.toISOString().slice(0, 10)}T00:00:00.000Z`);

  // Opening balances: every warehouse, 100 lines per document.
  let serialNo = 1;
  for (const w of warehouses) {
    const stocked = products.filter(() => rand() < 0.7);
    for (let i = 0; i < stocked.length; i += 100) {
      const at = nextAt();
      const doc = { id: randomUUID(), from: null, to: w.id, date: day(at), at };
      docs.push({ id: doc.id, number: docNo("OB", at.getUTCFullYear()), type: "OPENING", status: "DRAFT", toWarehouseId: w.id, documentDate: doc.date, createdById: admin.id, createdAt: at });
      for (const [n, p] of stocked.slice(i, i + 100).entries()) {
        const qty = p.serial ? int(2, 12) : p.fraction ? int(50, 500) : int(5, 400);
        const bin = pick(w.bins);
        const serials = p.serial ? Array.from({ length: qty }, () => `SN${String(serialNo++).padStart(8, "0")}`) : [];
        const lineId = randomUUID();
        lines.push({ id: lineId, documentId: doc.id, lineNo: n + 1, productId: p.id, quantity: new Prisma.Decimal(qty), unitCost: new Prisma.Decimal(p.cost), toBinId: bin, serials });
        move(doc, lineId, "OPENING_BALANCE", p, w.id, bin, qty, serials);
        if (serials.length) putSerials(p, w.id, bin, serials);
      }
    }
  }
  // Transfers to vans (3 lines) and issues from vans (2 lines), repeatedly.
  const main = warehouses[0]!;
  for (let r = 0; r < 4000; r++) {
    const van = pick(vans);
    const at = nextAt();
    const doc = { id: randomUUID(), from: main.id, to: van.id, date: day(at), at };
    const ls: { p: P; bin: string; qty: number; serials: string[] }[] = [];
    for (let k = 0; k < 3; k++) {
      const p = pick(products);
      if (ls.some((l) => l.p.id === p.id)) continue;
      const bin = main.bins.find((b) => (loc.get(`${p.id}|${main.id}|${b}`) ?? 0) >= 2);
      if (!bin) continue;
      const qty = p.serial ? 1 : Math.min(int(1, 5), Math.floor(loc.get(`${p.id}|${main.id}|${bin}`)!));
      const serials = p.serial ? takeSerials(p, main.id, bin, qty) : [];
      if (p.serial && serials.length < qty) continue;
      ls.push({ p, bin, qty, serials });
    }
    if (!ls.length) continue;
    docs.push({ id: doc.id, number: docNo("TRF", at.getUTCFullYear()), type: "TRANSFER", status: "DRAFT", fromWarehouseId: main.id, toWarehouseId: van.id, documentDate: doc.date, createdById: admin.id, createdAt: at });
    for (const [n, l] of ls.entries()) {
      const lineId = randomUUID();
      lines.push({ id: lineId, documentId: doc.id, lineNo: n + 1, productId: l.p.id, quantity: new Prisma.Decimal(l.qty), fromBinId: l.bin, serials: l.serials });
      move(doc, lineId, "TRANSFER_OUT", l.p, main.id, l.bin, -l.qty, l.serials);
      move(doc, lineId, "TRANSFER_IN", l.p, van.id, null, l.qty, l.serials);
      if (l.serials.length) putSerials(l.p, van.id, null, l.serials);
    }
    // Issue half of what this van holds of the first product.
    if (rand() < 0.75) {
      const l = ls[0]!;
      const have = loc.get(`${l.p.id}|${van.id}|`) ?? 0;
      if (have >= 1) {
        const at2 = nextAt();
        const iss = { id: randomUUID(), from: van.id, to: null, date: day(at2), at: at2 };
        const qty = l.p.serial ? 1 : Math.max(1, Math.floor(have / 2));
        const serials = l.p.serial ? takeSerials(l.p, van.id, null, qty) : [];
        docs.push({ id: iss.id, number: docNo("ISS", at2.getUTCFullYear()), type: "ISSUE", status: "DRAFT", fromWarehouseId: van.id, documentDate: iss.date, reference: `APT-${String(int(1, 33000)).padStart(6, "0")}`, createdById: admin.id, createdAt: at2 });
        const lineId = randomUUID();
        lines.push({ id: lineId, documentId: iss.id, lineNo: 1, productId: l.p.id, quantity: new Prisma.Decimal(qty), serials });
        move(iss, lineId, "ISSUE", l.p, van.id, null, -qty, serials);
      }
    }
  }

  // Write: documents as drafts, their lines, then posted; movements; balances; serials; sequences.
  for (let i = 0; i < docs.length; i += 2000) await prisma.stockDocument.createMany({ data: docs.slice(i, i + 2000) });
  for (let i = 0; i < lines.length; i += 2000) await prisma.stockDocumentLine.createMany({ data: lines.slice(i, i + 2000) });
  await prisma.$executeRaw`UPDATE "stock_documents" SET "status" = 'POSTED', "postedAt" = "createdAt", "postedById" = "createdById"`;
  for (let i = 0; i < moves.length; i += 2000) await prisma.inventoryMovement.createMany({ data: moves.slice(i, i + 2000) });
  const balances: Prisma.StockBalanceCreateManyInput[] = [];
  for (const [k, q] of loc) {
    const [productId, warehouseId, binKey] = k.split("|") as [string, string, string];
    balances.push({ id: randomUUID(), productId, warehouseId, binId: binKey || null, binKey, quantity: new Prisma.Decimal(q) });
  }
  for (let i = 0; i < balances.length; i += 2000) await prisma.stockBalance.createMany({ data: balances.slice(i, i + 2000) });
  const serials: Prisma.ProductSerialCreateManyInput[] = [];
  for (const [k, v] of serialAt) {
    const [productId, serial] = k.split("|") as [string, string];
    serials.push({ productId, serial, warehouseId: v.w, binId: v.b, lastMovementId: v.m });
  }
  for (let i = 0; i < serials.length; i += 2000) await prisma.productSerial.createMany({ data: serials.slice(i, i + 2000) });
  for (const [key, lastNumber] of seq) await prisma.documentSequence.create({ data: { key, lastNumber } });

  console.log(`products: ${products.length}, warehouses: ${warehouses.length + vans.length}, documents: ${docs.length}, lines: ${lines.length}, movements: ${moves.length}, balances: ${balances.length}, serials: ${serials.length}`);
  console.log(`Done in ${Math.round((Date.now() - t0) / 1000)} s.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
