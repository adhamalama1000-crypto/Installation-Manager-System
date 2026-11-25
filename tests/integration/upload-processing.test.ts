/**
 * Upload reservations cover the WHOLE request (Phase B, R9): an upload's share of the memory
 * budget (process total, per-user bytes and per-user count) is held from before the body is read
 * until its processing has finished (type checks, file write, waiting for row locks, database
 * transaction, cleanup), and released exactly once on every way out. A client that disconnects
 * does not stop that processing, so it does not release the reservation either. Uploads already at
 * their count limit are refused before any file is written; the checks under the row lock stay.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ExcelJS from "exceljs";
import type { User } from "@prisma/client";
import { POST as upload } from "@/app/api/appointments/[id]/attachments/route";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as uploadReceipt } from "@/app/api/expenses/[id]/receipt/route";
import { POST as uploadStocktakePhoto } from "@/app/api/stocktakes/[id]/photos/route";
import { POST as uploadProductImage } from "@/app/api/products/[id]/images/route";
import { POST as importProducts } from "@/app/api/products/import/route";
import { addExpense } from "@/server/services/expenses";
import { saveProduct } from "@/server/services/inventory-catalog";
import { saveWarehouse } from "@/server/services/inventory-warehouses";
import { createStocktake, startStocktake } from "@/server/services/stocktakes";
import { createAppointment } from "@/server/services/appointments";
import { MAX_PHOTOS, MAX_VIDEOS } from "@/server/services/attachments";
import { MAX_PRODUCT_IMAGES } from "@/server/services/product-images";
import { hashPassword } from "@/server/auth/password";
import { resetHashPoolForTests } from "@/server/auth/hash-pool";
import { readLimitedBody, uploadBytesInFlight } from "@/server/storage";
import { PRODUCT_COLUMNS, headerOf } from "@/lib/product-import";
import { appointmentPayload, asCurrent, makeUser, prisma, resetDb, seedStatuses } from "../helpers";

const PASSWORD = "Password123";
const JPEG_HEAD = [0xff, 0xd8, 0xff, 0xe0];
const MP4_HEAD = [0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]; // ....ftypisom
const MB = 1024 * 1024;
const ENV = ["UPLOAD_MAX_INFLIGHT_MB", "UPLOAD_IDLE_TIMEOUT_MS", "UPLOAD_TOTAL_TIMEOUT_MS", "UPLOAD_MAX_INFLIGHT_PER_USER_MB", "UPLOAD_MAX_CONCURRENT_PER_USER", "UPLOAD_MIN_RATE_KBPS", "UPLOAD_MIN_RATE_GRACE_MS"];

let dir: string;
let sales: User;
let apptId: string;
let salesCookie: string;
let passwordHash: string;

/** The process's reservation state (the same object storage.ts keeps on globalThis). */
type InFlight = { bytes: number; perOwner: Map<string, { bytes: number; count: number }> };
const state = () => (globalThis as unknown as Record<symbol, InFlight | undefined>)[Symbol.for("ims.uploadBytesInFlight")];
const uploadsInFlight = (owner: string) => state()?.perOwner.get(owner)?.count ?? 0;

async function cookieFor(email: string) {
  const res = await login(new Request("http://localhost:3000/api/auth/login", { method: "POST", headers: { host: "localhost:3000", "content-type": "application/json" }, body: JSON.stringify({ email, password: PASSWORD }) }));
  expect(res.status).toBe(200);
  return res.headers.getSetCookie().find((c) => c.startsWith("ims_session="))!.split(";")[0]!;
}
async function userWithCookie(role: Parameters<typeof makeUser>[0], email: string) {
  const user = await makeUser(role, { email, passwordHash });
  return { user, cookie: await cookieFor(email) };
}

const fileOf = (head: number[], n: number) => {
  const b = new Uint8Array(n);
  b.set(head);
  return b;
};
const jpeg = (n = 2000) => fileOf(JPEG_HEAD, n);

/** A request body stream that counts what the server pulled from it. */
function stream(total: number, opts: { chunk?: number; delayMs?: number } = {}) {
  const chunk = opts.chunk ?? 64 * 1024;
  const stats = { pulled: 0 };
  let sent = 0;
  const s = new ReadableStream<Uint8Array>({
    async pull(c) {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (sent >= total) return c.close();
      const n = Math.min(chunk, total - sent);
      const bytes = new Uint8Array(n);
      if (sent === 0) bytes.set(JPEG_HEAD);
      sent += n;
      stats.pulled = sent;
      c.enqueue(bytes);
    },
  });
  return { stream: s, stats };
}

/** A POST with a raw body and (for byte bodies) its Content-Length, as browsers send it. */
function post(url: string, cookie: string, b: ReadableStream<Uint8Array> | Uint8Array, opts: { len?: number; signal?: AbortSignal } = {}) {
  const len = opts.len ?? (b instanceof Uint8Array ? b.byteLength : undefined);
  return new Request(`http://localhost:3000${url}`, {
    method: "POST",
    headers: { host: "localhost:3000", cookie, "content-type": "application/octet-stream", ...(len !== undefined ? { "content-length": String(len) } : {}) },
    body: b as BodyInit,
    signal: opts.signal,
    // @ts-expect-error Node needs this for stream bodies
    duplex: "half",
  });
}
const p = (id: string) => ({ params: Promise.resolve({ id }) });
const attach = (cookie: string, kind: string, b: ReadableStream<Uint8Array> | Uint8Array, opts: { len?: number; signal?: AbortSignal } = {}) =>
  upload(post(`/api/appointments/${apptId}/attachments?kind=${kind}`, cookie, b, opts), p(apptId));
const files = async () => {
  try {
    return (await readdir(dir, { recursive: true, withFileTypes: true })).filter((f) => f.isFile()).length;
  } catch {
    return 0;
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => Promise<boolean> | boolean, what: string, ms = 10_000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await sleep(10);
  }
}
/** Sessions of this test database waiting for a row or advisory lock. */
async function lockWaiters() {
  const [r] = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
  return Number(r!.n);
}

/**
 * Holds `FOR UPDATE` on one row (or the import's advisory lock) in a separate transaction, so
 * uploads that reach their own transaction block there, mid-processing, with their reservation held.
 */
async function holdLock(sql: "appointment" | "product" | "import", id = "") {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  let ready!: () => void;
  const locked = new Promise<void>((r) => (ready = r));
  const done = prisma.$transaction(
    async (tx) => {
      if (sql === "appointment") await tx.$queryRaw`SELECT id FROM appointments WHERE id = ${id} FOR UPDATE`;
      else if (sql === "product") await tx.$queryRaw`SELECT id FROM products WHERE id = ${id} FOR UPDATE`;
      else await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('import:products', 0))`;
      ready();
      await gate;
    },
    { timeout: 60_000 },
  );
  await locked;
  const release = async () => {
    open();
    await done;
  };
  heldLocks.push(release);
  return release;
}
/** Locks still held when a test ends (it failed midway): released so the next test is not blocked. */
const heldLocks: (() => Promise<void>)[] = [];

/** An open stocktake of one product in a new warehouse, that `manager` may add photos to. */
async function openStocktake(manager: User, productId: string) {
  const warehouseId = (await saveWarehouse(asCurrent(manager), null, { code: "MAIN", nameEn: "Main", nameAr: "الرئيسي", kind: "WAREHOUSE" })).id;
  const { id } = await createStocktake(asCurrent(manager), { warehouseId, productIds: [productId], name: "Spot check" });
  await startStocktake(asCurrent(manager), id);
  return id;
}

/** Seeds `n` live attachment rows of `kind` (files are not needed for counting). */
async function seedAttachments(kind: "BEFORE_PHOTO" | "VIDEO", n: number) {
  await prisma.attachment.createMany({
    data: Array.from({ length: n }, (_, i) => ({ appointmentId: apptId, kind, contentType: kind === "VIDEO" ? "video/mp4" : "image/jpeg", byteSize: 1, sha256: "x", storageKey: `seed/${kind}-${i}`, uploadedById: sales.id })),
  });
}

/** Points UPLOAD_DIR at a regular file: any attempt to write an upload fails (500). */
async function makeStorageUnwritable() {
  const blocker = path.join(dir, "not-a-directory");
  await writeFile(blocker, "x");
  process.env.UPLOAD_DIR = blocker;
}

beforeEach(async () => {
  for (const k of ENV) delete process.env[k];
  await resetHashPoolForTests();
  await resetDb();
  await seedStatuses();
  dir = await mkdtemp(path.join(os.tmpdir(), "ims-upload-processing-"));
  process.env.UPLOAD_DIR = dir;
  passwordHash ??= await hashPassword(PASSWORD);
  sales = await makeUser("SALES", { email: "sales@test.local", passwordHash });
  apptId = (await createAppointment(asCurrent(sales), appointmentPayload())).id;
  salesCookie = await cookieFor(sales.email);
});
afterEach(async () => {
  await Promise.all(heldLocks.splice(0).map((release) => release().catch(() => undefined)));
  vi.restoreAllMocks();
  for (const k of ENV) delete process.env[k];
  await rm(dir, { recursive: true, force: true });
});

describe("the reservation lasts until processing has finished", () => {
  it("three uploads blocked in processing keep their reservation; a 4th by the same user gets 429 unread", async () => {
    const release = await holdLock("appointment", apptId);
    const three = [1, 2, 3].map(() => attach(salesCookie, "BEFORE_PHOTO", jpeg(MB)));
    // All three have been read, written their file and are now waiting for the visit's row lock.
    await until(async () => (await lockWaiters()) >= 3, "three uploads waiting on the row lock");
    expect(await files()).toBe(3);
    expect(uploadBytesInFlight(sales.id)).toBe(3 * MB);
    expect(uploadsInFlight(sales.id)).toBe(3);
    expect(uploadBytesInFlight()).toBe(3 * MB);

    const fourth = stream(MB);
    const r4 = await attach(salesCookie, "BEFORE_PHOTO", fourth.stream, { len: MB });
    expect(r4.status).toBe(429);
    expect(r4.headers.get("retry-after")).toBeTruthy();
    expect(fourth.stats.pulled).toBeLessThanOrEqual(64 * 1024 * 2);
    expect(await files()).toBe(3); // the refused one wrote nothing
    expect(uploadsInFlight(sales.id)).toBe(3);

    await release();
    expect((await Promise.all(three)).map((r) => r.status)).toEqual([200, 200, 200]);
    expect(uploadBytesInFlight()).toBe(0);
    expect(uploadsInFlight(sales.id)).toBe(0);
    expect(await prisma.attachment.count()).toBe(3);
  });

  it("uploads blocked in processing count against the process budget: another user gets 503", async () => {
    process.env.UPLOAD_MAX_INFLIGHT_MB = "3";
    const other = await userWithCookie("ADMIN", "admin@test.local");
    const release = await holdLock("appointment", apptId);
    const three = [1, 2, 3].map(() => attach(salesCookie, "BEFORE_PHOTO", jpeg(MB)));
    await until(async () => (await lockWaiters()) >= 3, "three uploads waiting on the row lock");
    expect(uploadBytesInFlight()).toBe(3 * MB);
    const r = await attach(other.cookie, "BEFORE_PHOTO", jpeg(MB));
    expect(r.status).toBe(503);
    expect(uploadBytesInFlight(other.user.id)).toBe(0);
    await release();
    expect((await Promise.all(three)).map((x) => x.status)).toEqual([200, 200, 200]);
    expect(uploadBytesInFlight()).toBe(0);
    // Budget free again: the other user's upload now goes through.
    expect((await attach(other.cookie, "BEFORE_PHOTO", jpeg(MB))).status).toBe(200);
    expect(uploadBytesInFlight()).toBe(0);
  });

  it("is held during the database work on every upload route", async () => {
    const tech = await userWithCookie("TECHNICIAN", "tech@test.local");
    const manager = await userWithCookie("WAREHOUSE_MANAGER", "manager@test.local");
    const expense = await addExpense(asCurrent(tech.user), { amount: 50 });
    const product = await saveProduct(asCurrent(manager.user), null, { sku: "IMG-1", nameEn: "Lock", nameAr: "قفل", unitId: "unit-pcs" });
    const stocktake = await openStocktake(manager.user, product.id);

    // What each owner had reserved at the moment the route's database write ran.
    const seen: number[] = [];
    const tx = prisma.$transaction.bind(prisma);
    vi.spyOn(prisma, "$transaction").mockImplementation(((...args: Parameters<typeof prisma.$transaction>) => {
      seen.push(state()?.bytes ?? 0);
      return tx(...args);
    }) as typeof prisma.$transaction);
    const cas = prisma.transportExpense.updateMany.bind(prisma.transportExpense);
    vi.spyOn(prisma.transportExpense, "updateMany").mockImplementation(((...args: Parameters<typeof cas>) => {
      seen.push(state()?.bytes ?? 0);
      return cas(...args);
    }) as unknown as typeof prisma.transportExpense.updateMany);

    const photo = jpeg(3000);
    expect((await attach(salesCookie, "BEFORE_PHOTO", photo)).status).toBe(200);
    expect(seen.pop()).toBe(photo.byteLength);
    expect((await uploadReceipt(post(`/api/expenses/${expense.id}/receipt`, tech.cookie, photo), p(expense.id))).status).toBe(200);
    expect(seen.pop()).toBe(photo.byteLength);
    expect((await uploadProductImage(post(`/api/products/${product.id}/images`, manager.cookie, photo), p(product.id))).status).toBe(201);
    expect(seen.pop()).toBe(photo.byteLength);
    expect((await uploadStocktakePhoto(post(`/api/stocktakes/${stocktake}/photos`, manager.cookie, photo), p(stocktake))).status).toBe(201);
    expect(seen.pop()).toBe(photo.byteLength);
    const xlsx = await importWorkbook();
    expect((await importProducts(post("/api/products/import?mode=commit", manager.cookie, xlsx), p(""))).status).toBe(200);
    expect(seen.pop()).toBe(xlsx.byteLength);
    expect(uploadBytesInFlight()).toBe(0);
  });
});

describe("the reservation is released exactly once on every way out", () => {
  it("success, wrong type, count limit, an exception, a database failure (with the file cleaned up)", async () => {
    const back = async (res: Promise<Response>, status: number) => {
      expect((await res).status).toBe(status);
      expect(uploadBytesInFlight()).toBe(0);
      expect(uploadsInFlight(sales.id)).toBe(0);
    };
    await back(attach(salesCookie, "BEFORE_PHOTO", jpeg()), 200); // success
    await back(attach(salesCookie, "BEFORE_PHOTO", new TextEncoder().encode("<html>no</html>")), 422); // wrong type
    await back(attach(salesCookie, "BEFORE_PHOTO", jpeg(9 * MB), { len: 9 * MB }), 422); // too large (declared)
    await back(attach(salesCookie, "BEFORE_PHOTO", stream(9 * MB).stream), 422); // too large (counted)
    expect(await files()).toBe(1);

    // A database failure inside processing: 500, the file it wrote is removed, nothing reserved.
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(new Error("database unavailable"));
    await back(attach(salesCookie, "BEFORE_PHOTO", jpeg()), 500);
    expect(await files()).toBe(1);
    expect(await prisma.attachment.count()).toBe(1);

    // An exception before the database (the file cannot be written): 500, nothing reserved.
    await makeStorageUnwritable();
    await back(attach(salesCookie, "BEFORE_PHOTO", jpeg()), 500);
    process.env.UPLOAD_DIR = dir;
    expect(errors).toHaveBeenCalled();

    // Count limit reached (photos): 422.
    await seedAttachments("BEFORE_PHOTO", MAX_PHOTOS - 1);
    await back(attach(salesCookie, "BEFORE_PHOTO", jpeg()), 422);
  });

  it("on the other routes too (receipt, stocktake photo, product image, import)", async () => {
    const tech = await userWithCookie("TECHNICIAN", "tech@test.local");
    const manager = await userWithCookie("WAREHOUSE_MANAGER", "manager@test.local");
    const expense = await addExpense(asCurrent(tech.user), { amount: 50 });
    const product = await saveProduct(asCurrent(manager.user), null, { sku: "IMG-2", nameEn: "Lock", nameAr: "قفل", unitId: "unit-pcs" });
    const stocktake = await openStocktake(manager.user, product.id);
    const html = new TextEncoder().encode("<html>no</html>");
    const cases: [string, number, number][] = [
      ["receipt, wrong type", (await uploadReceipt(post(`/api/expenses/${expense.id}/receipt`, tech.cookie, html), p(expense.id))).status, 422],
      ["receipt", (await uploadReceipt(post(`/api/expenses/${expense.id}/receipt`, tech.cookie, jpeg()), p(expense.id))).status, 200],
      ["stocktake photo, wrong type", (await uploadStocktakePhoto(post(`/api/stocktakes/${stocktake}/photos`, manager.cookie, html), p(stocktake))).status, 422],
      ["stocktake photo", (await uploadStocktakePhoto(post(`/api/stocktakes/${stocktake}/photos`, manager.cookie, jpeg()), p(stocktake))).status, 201],
      ["product image, wrong type", (await uploadProductImage(post(`/api/products/${product.id}/images`, manager.cookie, html), p(product.id))).status, 422],
      ["product image", (await uploadProductImage(post(`/api/products/${product.id}/images`, manager.cookie, jpeg()), p(product.id))).status, 201],
      ["import, not a workbook", (await importProducts(post("/api/products/import", manager.cookie, html), p(""))).status, 422],
      ["import preview", (await importProducts(post("/api/products/import", manager.cookie, await importWorkbook()), p(""))).status, 200],
    ];
    for (const [name, got, want] of cases) expect(got, name).toBe(want);
    expect(uploadBytesInFlight()).toBe(0);
    expect(uploadsInFlight(tech.user.id)).toBe(0);
    expect(uploadsInFlight(manager.user.id)).toBe(0);
  });
});

describe("a client that disconnects during processing", () => {
  it("does not release the reservation: the server finishes the work, then releases it", async () => {
    const release = await holdLock("appointment", apptId);
    const client = new AbortController();
    const req = post(`/api/appointments/${apptId}/attachments?kind=BEFORE_PHOTO`, salesCookie, jpeg(MB), { signal: client.signal });
    const pending = upload(req, p(apptId));
    await until(async () => (await lockWaiters()) >= 1, "the upload waiting on the row lock");
    client.abort(); // the browser goes away while the server is still processing
    expect(req.signal.aborted).toBe(true);
    await sleep(200);
    // The handler is still running (waiting for the lock, its file written) and still reserved.
    expect(await lockWaiters()).toBe(1);
    expect(await files()).toBe(1);
    expect(uploadBytesInFlight(sales.id)).toBe(MB);
    expect(uploadsInFlight(sales.id)).toBe(1);
    // ...so it still counts against the user's share.
    process.env.UPLOAD_MAX_CONCURRENT_PER_USER = "1";
    expect((await attach(salesCookie, "BEFORE_PHOTO", jpeg())).status).toBe(429);
    await release();
    // Processing really completed after the disconnect: row stored, file kept, reservation back.
    expect((await pending).status).toBe(200);
    expect(await prisma.attachment.count()).toBe(1);
    expect(await files()).toBe(1);
    expect(uploadBytesInFlight()).toBe(0);
    expect(uploadsInFlight(sales.id)).toBe(0);
  });
});

describe("count limits are checked before any file is written", () => {
  it("attachments at the photo or video limit get 422 without a write; below it a write is attempted", async () => {
    await seedAttachments("BEFORE_PHOTO", MAX_PHOTOS);
    await seedAttachments("VIDEO", MAX_VIDEOS);
    await makeStorageUnwritable(); // any write attempt would now answer 500
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await attach(salesCookie, "BEFORE_PHOTO", jpeg())).status).toBe(422);
    expect((await attach(salesCookie, "VIDEO", fileOf(MP4_HEAD, 4000))).status).toBe(422);
    expect((await attach(salesCookie, "AFTER_PHOTO", jpeg())).status).toBe(500); // control: below its limit, the write is tried
    expect(uploadBytesInFlight()).toBe(0);
  });

  it("product images at the limit get 422 without a write", async () => {
    const manager = await userWithCookie("WAREHOUSE_MANAGER", "manager@test.local");
    const full = await saveProduct(asCurrent(manager.user), null, { sku: "IMG-F", nameEn: "Full", nameAr: "ممتلئ", unitId: "unit-pcs" });
    const empty = await saveProduct(asCurrent(manager.user), null, { sku: "IMG-E", nameEn: "Empty", nameAr: "فارغ", unitId: "unit-pcs" });
    await prisma.productImage.createMany({
      data: Array.from({ length: MAX_PRODUCT_IMAGES }, (_, i) => ({ productId: full.id, contentType: "image/jpeg", byteSize: 1, sha256: "x", storageKey: `seed/p-${i}`, sortOrder: i, uploadedById: manager.user.id })),
    });
    await makeStorageUnwritable();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await uploadProductImage(post(`/api/products/${full.id}/images`, manager.cookie, jpeg()), p(full.id))).status).toBe(422);
    expect((await uploadProductImage(post(`/api/products/${empty.id}/images`, manager.cookie, jpeg()), p(empty.id))).status).toBe(500); // control
    expect(uploadBytesInFlight()).toBe(0);
  });

  it("the checks under the row lock still decide a race at the limit (one stored, the other's file removed)", async () => {
    await seedAttachments("BEFORE_PHOTO", MAX_PHOTOS - 1);
    const release = await holdLock("appointment", apptId);
    // Both pass the early check (one slot left), write their file and wait for the lock.
    const two = [1, 2].map(() => attach(salesCookie, "BEFORE_PHOTO", jpeg()));
    await until(async () => (await lockWaiters()) >= 2, "two uploads waiting on the row lock");
    expect(await files()).toBe(2);
    await release();
    expect((await Promise.all(two)).map((r) => r.status).sort()).toEqual([200, 422]);
    expect(await prisma.attachment.count({ where: { kind: "BEFORE_PHOTO", deletedAt: null } })).toBe(MAX_PHOTOS);
    expect(await files()).toBe(1);
    expect(uploadBytesInFlight()).toBe(0);
  });
});

/** A one-product workbook the import accepts. */
async function importWorkbook() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Products");
  ws.addRow(PRODUCT_COLUMNS.map(headerOf));
  const row: Record<string, string> = { sku: `IMP-${Math.random().toString(36).slice(2, 8).toUpperCase()}`, name_en: "Imported lock", name_ar: "قفل مستورد", unit: "PCS" };
  ws.addRow(PRODUCT_COLUMNS.map((c) => row[c.key] ?? ""));
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

describe("product import", () => {
  it("holds the reservation while the workbook is parsed and while the commit runs", async () => {
    const manager = await userWithCookie("WAREHOUSE_MANAGER", "manager@test.local");
    const xlsx = await importWorkbook();
    // Parsing: what was reserved when ExcelJS loaded the file.
    const proto = Object.getPrototypeOf(new ExcelJS.Workbook().xlsx) as { load: (...a: unknown[]) => Promise<unknown> };
    const load = proto.load;
    const atParse: number[] = [];
    vi.spyOn(proto, "load").mockImplementation(function (this: unknown, ...a: unknown[]) {
      atParse.push(uploadBytesInFlight(manager.user.id));
      return load.apply(this, a);
    });
    expect((await importProducts(post("/api/products/import", manager.cookie, xlsx), p(""))).status).toBe(200);
    expect(atParse).toEqual([xlsx.byteLength]);
    expect(uploadBytesInFlight()).toBe(0);

    // Commit: blocked on the import lock (another import running), still reserved.
    const release = await holdLock("import");
    const pending = importProducts(post("/api/products/import?mode=commit", manager.cookie, xlsx), p(""));
    await until(async () => (await lockWaiters()) >= 1, "the commit waiting on the import lock");
    expect(uploadBytesInFlight(manager.user.id)).toBe(xlsx.byteLength);
    expect(uploadsInFlight(manager.user.id)).toBe(1);
    await release();
    const res = await pending;
    expect(res.status).toBe(200);
    expect((await res.json()).committed).toBe(true);
    expect(uploadBytesInFlight()).toBe(0);
  });
});

describe("stress: many users uploading at once", () => {
  it("never exceeds the process budget or any user's share, and every reservation comes back", async () => {
    process.env.UPLOAD_MAX_INFLIGHT_MB = "5";
    process.env.UPLOAD_MAX_INFLIGHT_PER_USER_MB = "2";
    const users = [{ user: sales, cookie: salesCookie }, await userWithCookie("ADMIN", "a1@test.local"), await userWithCookie("ADMIN", "a2@test.local")];
    const budget = 5 * MB;
    const perUser = 2 * MB;
    // Slow down the database work a little so reservations overlap processing.
    const tx = prisma.$transaction.bind(prisma);
    vi.spyOn(prisma, "$transaction").mockImplementation((async (...args: Parameters<typeof prisma.$transaction>) => {
      await sleep(30);
      return tx(...args);
    }) as typeof prisma.$transaction);

    const violations: string[] = [];
    let maxTotal = 0;
    let maxFiles = 0;
    const sampler = setInterval(() => {
      const s = state();
      if (!s) return;
      maxTotal = Math.max(maxTotal, s.bytes);
      if (s.bytes > budget) violations.push(`total ${s.bytes}`);
      for (const [owner, mine] of s.perOwner) {
        if (mine.bytes > perUser) violations.push(`${owner} bytes ${mine.bytes}`);
        if (mine.count > 3) violations.push(`${owner} count ${mine.count}`);
      }
    }, 2);
    const fileSampler = setInterval(() => void files().then((n) => (maxFiles = Math.max(maxFiles, n))), 5);

    const sizes = [512 * 1024, 700 * 1024, MB];
    const requests = users.flatMap((u, ui) =>
      Array.from({ length: 6 }, (_, i) => {
        const size = sizes[(ui + i) % sizes.length]!;
        // Half declare their length, half are counted (reserved at the 8 MB limit: always refused here).
        const b = i % 2 === 0 ? { body: stream(size, { chunk: 64 * 1024, delayMs: 2 }).stream, len: size } : { body: jpeg(size), len: undefined };
        return attach(u.cookie, "BEFORE_PHOTO", b.body, { len: b.len });
      }),
    );
    const codes = (await Promise.all(requests)).map((r) => r.status);
    clearInterval(sampler);
    clearInterval(fileSampler);

    expect(violations).toEqual([]);
    expect(codes.every((c) => c === 200 || c === 429 || c === 503), codes.join(",")).toBe(true);
    expect(codes.filter((c) => c === 200).length).toBeGreaterThan(0);
    expect(codes.filter((c) => c !== 200).length).toBeGreaterThan(0);
    expect(maxTotal).toBeGreaterThan(0);
    expect(maxTotal).toBeLessThanOrEqual(budget);
    // Files on disk at any moment never exceed what the stored uploads account for.
    const stored = codes.filter((c) => c === 200).length;
    expect(maxFiles).toBeLessThanOrEqual(stored);
    expect(await files()).toBe(stored);
    expect(await prisma.attachment.count()).toBe(stored);
    expect(uploadBytesInFlight()).toBe(0);
    for (const u of users) expect(uploadsInFlight(u.user.id)).toBe(0);
  });
});

describe("reading into one buffer when the length is declared", () => {
  /** A stream that sends `bytes` in uneven chunks, then optionally `extra` more bytes. */
  const chunked = (bytes: Uint8Array, extra = 0) => {
    let at = 0;
    let sizes = [1, 7, 4096, 65_537, 3, 100_000];
    const all = new Uint8Array(bytes.byteLength + extra);
    all.set(bytes);
    return new ReadableStream<Uint8Array>({
      pull(c) {
        if (at >= all.byteLength) return c.close();
        const n = Math.min(sizes[0]!, all.byteLength - at);
        sizes = [...sizes.slice(1), sizes[0]!];
        c.enqueue(all.slice(at, at + n));
        at += n;
      },
    });
  };
  const req = (b: ReadableStream<Uint8Array>, len?: number) =>
    // @ts-expect-error Node needs this for stream bodies
    new Request("http://localhost:3000/x", { method: "POST", headers: len === undefined ? {} : { "content-length": String(len) }, body: b, duplex: "half" });

  it("returns exactly the bytes sent, with or without a declared length", async () => {
    const data = new Uint8Array(randomBytes(1_234_567));
    const declared = await readLimitedBody(req(chunked(data), data.byteLength), 8 * MB, { owner: "o" });
    const counted = await readLimitedBody(req(chunked(data)), 8 * MB, { owner: "o" });
    for (const got of [declared, counted]) {
      expect(got!.byteLength).toBe(data.byteLength);
      expect(Buffer.from(got!).equals(Buffer.from(data))).toBe(true);
    }
    expect(uploadBytesInFlight()).toBe(0);
  });

  it("answers a body shorter or longer than declared as before (400; null once past the limit)", async () => {
    const data = new Uint8Array(randomBytes(300_000));
    await expect(readLimitedBody(req(chunked(data), data.byteLength + 10), 8 * MB)).rejects.toMatchObject({ status: 400 });
    await expect(readLimitedBody(req(chunked(data, 10), data.byteLength), 8 * MB)).rejects.toMatchObject({ status: 400 });
    // Longer than declared AND past the limit: null ("too large"), as before.
    expect(await readLimitedBody(req(chunked(data, 200_000), data.byteLength), 400_000)).toBeNull();
    expect(uploadBytesInFlight()).toBe(0);
  });

  it("a stored upload's hash matches the bytes sent (declared length, stream body)", async () => {
    const data = new Uint8Array(randomBytes(2 * MB));
    data.set(JPEG_HEAD);
    expect((await attach(salesCookie, "BEFORE_PHOTO", chunked(data), { len: data.byteLength })).status).toBe(200);
    const row = await prisma.attachment.findFirstOrThrow();
    expect(row.byteSize).toBe(data.byteLength);
    expect(row.sha256).toBe(createHash("sha256").update(data).digest("hex"));
  });
});
