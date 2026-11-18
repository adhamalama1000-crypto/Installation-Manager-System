/**
 * Phase 2: item lock / archive, stocktake schedules (daily, monthly, annual, custom) without
 * duplicate sessions, planned sessions (start, postpone, cancel), scoped snapshots, damaged /
 * missing / excess, the append-only count history, recounts, separation of duties, the ledger
 * adjustment on approval, and who may do what.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { User } from "@prisma/client";
import { getProduct, listProducts, saveCategory, saveProduct } from "@/server/services/inventory-catalog";
import { archiveProduct, lockProduct, unarchiveProduct, unlockProduct } from "@/server/services/product-lock";
import { saveWarehouse } from "@/server/services/inventory-warehouses";
import { createDocument } from "@/server/services/inventory-documents";
import {
  approveStocktake,
  cancelStocktake,
  createStocktake,
  getStocktake,
  returnForRecount,
  saveCounts,
  startStocktake,
  submitStocktake,
  updatePlannedStocktake,
  uploadStocktakePhoto,
} from "@/server/services/stocktakes";
import { createSchedule, listSchedules, planSessions, updateSchedule } from "@/server/services/stocktake-schedules";
import { stocktakeDashboard } from "@/server/services/stocktake-dashboard";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { DEFAULT_TIMEZONE } from "@/lib/constants";
import { todayKey } from "@/lib/time";
import { asCurrent, makeUser, prisma, resetDb } from "../helpers";

const tz = DEFAULT_TIMEZONE;
const day = todayKey(tz);
const addDays = (k: string, n: number) => new Date(Date.parse(`${k}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

let manager: User, store: User, store2: User, tech: User, admin: User;
let main: string, locks: string, lock: string, cable: string;

beforeEach(async () => {
  await resetDb();
  admin = await makeUser("ADMIN");
  manager = await makeUser("WAREHOUSE_MANAGER", { name: "Wael Manager" });
  store = await makeUser("STORE", { name: "Samy Store" });
  store2 = await makeUser("STORE", { name: "Sara Store" });
  tech = await makeUser("TECHNICIAN");
  const m = asCurrent(manager);
  main = (await saveWarehouse(m, null, { code: "MAIN", nameEn: "Main store", nameAr: "المخزن الرئيسي", kind: "WAREHOUSE" })).id;
  locks = (await saveCategory(m, null, { nameEn: "Locks", nameAr: "أقفال" })).id;
  lock = (await saveProduct(m, null, { sku: "LK-1", nameEn: "Lock", nameAr: "قفل", unitId: "unit-pcs", purchaseCost: 1000, categoryId: locks })).id;
  cable = (await saveProduct(m, null, { sku: "CBL-1", nameEn: "Cable", nameAr: "سلك", unitId: "unit-m", purchaseCost: 10 })).id;
  await createDocument(asCurrent(store), { type: "RECEIPT", toWarehouseId: main, documentDate: day, lines: [{ productId: lock, quantity: 100 }, { productId: cable, quantity: 50 }] }, { post: true });
});

const as = (u: User, s: Record<string, unknown> = {}) => asCurrent(u, s);
async function qty(productId: string) {
  const b = await prisma.stockBalance.findUnique({ where: { productId_warehouseId_binKey: { productId, warehouseId: main, binKey: "" } } });
  return b ? b.quantity.toNumber() : 0;
}

describe("item lock and archive", () => {
  it("a locked item cannot be edited (service and database), stock still moves, and only products.unlock unlocks it", async () => {
    const p = await lockProduct(as(manager), lock, { reason: "catalogue checked" });
    expect(p.locked?.by?.name).toBe("Wael Manager");
    expect(p.locked?.reason).toBe("catalogue checked");
    await expect(saveProduct(as(manager), lock, { sku: "LK-1", nameEn: "Renamed", nameAr: "قفل", unitId: "unit-pcs" })).rejects.toThrow(/locked/);
    // The database refuses it too, whatever code path tries.
    await expect(prisma.product.update({ where: { id: lock }, data: { nameEn: "Sneaky" } })).rejects.toThrow(/locked or archived/);
    // Stock still moves.
    await createDocument(asCurrent(store), { type: "ISSUE", fromWarehouseId: main, documentDate: day, lines: [{ productId: lock, quantity: 1 }] }, { post: true });
    expect(await qty(lock)).toBe(99);
    // A store keeper may neither lock nor unlock.
    await expect(unlockProduct(as(store), lock, {})).rejects.toBeInstanceOf(ForbiddenError);
    await expect(lockProduct(as(store), cable, {})).rejects.toBeInstanceOf(ForbiddenError);
    await unlockProduct(as(manager), lock, { reason: "price change" });
    await saveProduct(as(manager), lock, { sku: "LK-1", nameEn: "Lock v2", nameAr: "قفل", unitId: "unit-pcs" });
    const audit = await prisma.auditLog.findMany({ where: { entityId: lock, action: { in: ["PRODUCT_LOCKED", "PRODUCT_UNLOCKED"] } }, orderBy: { createdAt: "asc" } });
    expect(audit.map((a) => [a.action, a.reason])).toEqual([["PRODUCT_LOCKED", "catalogue checked"], ["PRODUCT_UNLOCKED", "price change"]]);
  });

  it("archives only an item without stock: it becomes inactive, hidden and read-only, and can be brought back", async () => {
    await expect(archiveProduct(as(manager), cable, {})).rejects.toThrow(/still has stock/);
    await createDocument(asCurrent(store), { type: "ISSUE", fromWarehouseId: main, documentDate: day, lines: [{ productId: cable, quantity: 50 }] }, { post: true });
    await lockProduct(as(manager), cable, {});
    await expect(archiveProduct(as(manager), cable, {})).rejects.toThrow(/Unlock it before archiving/);
    await unlockProduct(as(manager), cable, {});
    const a = await archiveProduct(as(manager), cable, { reason: "discontinued" });
    expect(a.isActive).toBe(false);
    expect(a.archived).not.toBeNull();
    expect((await listProducts(as(manager), { active: "all" })).rows.map((r) => r.sku)).toContain("CBL-1");
    expect((await listProducts(as(manager), {})).rows.map((r) => r.sku)).not.toContain("CBL-1");
    expect((await listProducts(as(manager), { active: "archived" })).rows.map((r) => r.sku)).toEqual(["CBL-1"]);
    await expect(saveProduct(as(manager), cable, { sku: "CBL-1", nameEn: "Cable", nameAr: "سلك", unitId: "unit-m", isActive: true })).rejects.toThrow(/archived/);
    // History stays readable.
    expect((await getProduct(as(manager), cable)).hasMovements).toBe(true);
    const back = await unarchiveProduct(as(manager), cable, {});
    expect(back.archived).toBeNull();
    expect(back.isActive).toBe(false);
  });

  it("stores technical specifications and refuses invalid ones", async () => {
    const p = await saveProduct(as(manager), cable, { sku: "CBL-1", nameEn: "Cable", nameAr: "سلك", unitId: "unit-m", specifications: [{ key: "Gauge", keyAr: "المقاس", value: "2 x 1.5 mm" }] });
    expect(p.specifications).toEqual([{ key: "Gauge", keyAr: "المقاس", value: "2 x 1.5 mm" }]);
    await expect(saveProduct(as(manager), cable, { sku: "CBL-1", nameEn: "Cable", nameAr: "سلك", unitId: "unit-m", specifications: [{ key: "", value: "x" }] })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("stocktake schedules", () => {
  const schedule = (o: Record<string, unknown> = {}) => ({ name: "Daily count", warehouseId: main, kind: "DAILY", recurrence: "DAILY", interval: 1, startDate: day, endDate: null, startTime: "23:00", durationMinutes: 60, supervisorId: null, ...o });

  it("a daily schedule plans its sessions ahead, and planning again (even at the same time) never duplicates them", async () => {
    const { id } = await createSchedule(as(manager), schedule());
    const count = () => prisma.stocktake.count({ where: { scheduleId: id } });
    const first = await count();
    expect(first).toBeGreaterThanOrEqual(45);
    await Promise.all([planSessions(tz, [id]), planSessions(tz, [id]), planSessions(tz)]);
    expect(await count()).toBe(first);
    const s = await prisma.stocktake.findFirstOrThrow({ where: { scheduleId: id }, orderBy: { occurrenceDate: "asc" } });
    expect(s.status).toBe("PLANNED");
    expect(s.snapshotAt).toBeNull();
    expect((await listSchedules(as(manager)))[0]!.next).toBe(day);
  });

  it("monthly and annual schedules occur on the right days", async () => {
    const monthly = await createSchedule(as(manager), schedule({ name: "Monthly", kind: "MONTHLY", recurrence: "MONTHLY", startDate: addDays(day, 1) }));
    const days = (await prisma.stocktake.findMany({ where: { scheduleId: monthly.id }, orderBy: { occurrenceDate: "asc" } })).map((s) => s.occurrenceDate!.toISOString().slice(0, 10));
    expect(days[0]).toBe(addDays(day, 1));
    expect(days.length).toBeGreaterThanOrEqual(1);
    expect(days.length).toBeLessThanOrEqual(2);
    const annual = await createSchedule(as(manager), schedule({ name: "Annual", kind: "ANNUAL", recurrence: "YEARLY", startDate: addDays(day, 200) }));
    const a = await prisma.stocktake.findMany({ where: { scheduleId: annual.id } });
    expect(a.map((s) => s.occurrenceDate!.toISOString().slice(0, 10))).toEqual([addDays(day, 200)]);
  });

  it("editing a schedule updates its untouched planned sessions, keeps postponed ones, and ending it cancels them", async () => {
    const { id } = await createSchedule(as(manager), schedule({ recurrence: "WEEKLY", startDate: addDays(day, 1) }));
    const sessions = await prisma.stocktake.findMany({ where: { scheduleId: id }, orderBy: { occurrenceDate: "asc" } });
    expect(sessions.length).toBeGreaterThanOrEqual(6);
    // Postpone the first one by hand.
    const first = sessions[0]!;
    await updatePlannedStocktake(as(manager), first.id, { date: addDays(day, 2), startTime: "10:00", durationMinutes: 60, assigneeIds: [store.id], supervisorId: null, reason: "Inventory truck arrives" });
    const sch = (await listSchedules(as(manager)))[0]!;
    await updateSchedule(as(manager), id, { ...schedule({ recurrence: "WEEKLY", startDate: addDays(day, 1) }), startTime: "08:30", version: sch.version });
    const after = await prisma.stocktake.findMany({ where: { scheduleId: id, status: "PLANNED" }, orderBy: { occurrenceDate: "asc" } });
    const postponed = after.find((s) => s.id === first.id)!;
    expect(postponed.postponedFrom).not.toBeNull();
    expect(postponed.postponeReason).toBe("Inventory truck arrives");
    expect(postponed.assigneeIds).toEqual([store.id]);
    expect(after.filter((s) => s.id !== first.id).every((s) => s.plannedStart!.toISOString().endsWith(":30:00.000Z"))).toBe(true);
    const sch2 = (await listSchedules(as(manager)))[0]!;
    await updateSchedule(as(manager), id, { ...schedule({ recurrence: "WEEKLY", startDate: addDays(day, 1) }), status: "ENDED", version: sch2.version });
    expect(await prisma.stocktake.count({ where: { scheduleId: id, status: "PLANNED" } })).toBe(0);
  });

  it("only planners manage schedules; postponing needs a reason; a mandatory session is cancelled only with a reason", async () => {
    await expect(createSchedule(as(store), schedule())).rejects.toBeInstanceOf(ForbiddenError);
    const { id } = await createSchedule(as(manager), schedule({ recurrence: "NONE", startDate: addDays(day, 3), mandatory: true }));
    const s = await prisma.stocktake.findFirstOrThrow({ where: { scheduleId: id } });
    await expect(updatePlannedStocktake(as(store), s.id, { date: addDays(day, 4), startTime: "09:00", durationMinutes: 60, assigneeIds: [], supervisorId: null })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(updatePlannedStocktake(as(manager), s.id, { date: addDays(day, 4), startTime: "09:00", durationMinutes: 60, assigneeIds: [], supervisorId: null })).rejects.toBeInstanceOf(ValidationError);
    await expect(cancelStocktake(as(manager), s.id, {})).rejects.toBeInstanceOf(ValidationError);
    await cancelStocktake(as(manager), s.id, { note: "warehouse closed for renovation" });
    expect((await prisma.stocktake.findUniqueOrThrow({ where: { id: s.id } })).status).toBe("CANCELLED");
  });
});

describe("counting a planned session", () => {
  async function plannedSession(o: Record<string, unknown> = {}) {
    const { id } = await createSchedule(as(manager), { name: "Locks count", warehouseId: main, kind: "CUSTOM", recurrence: "NONE", interval: 1, startDate: day, endDate: null, startTime: "00:00", durationMinutes: 1440, supervisorId: null, ...o });
    return (await prisma.stocktake.findFirstOrThrow({ where: { scheduleId: id } })).id;
  }

  it("100 in the system, 95 counted: the difference is recorded and only an approval posts the -5 adjustment to the ledger", async () => {
    const id = await plannedSession({ categoryIds: [locks], assigneeIds: [store.id, store2.id] });
    // Assignees only.
    const store3 = await makeUser("STORE", { name: "Not assigned" });
    await expect(startStocktake(as(store3), id)).rejects.toBeInstanceOf(ForbiddenError);
    let s = await startStocktake(as(store), id);
    expect(s.status).toBe("COUNTING");
    // Scoped snapshot: only the Locks category.
    expect(s.lines.map((l) => [l.product.sku, l.systemQuantity])).toEqual([["LK-1", 100]]);
    const line = s.lines[0]!;
    s = await saveCounts(as(store), id, { lines: [{ lineId: line.id, countedQuantity: 95, countedSerials: [], damagedQuantity: 2, reason: "5 missing, 2 damaged boxes" }] });
    expect(s.lines[0]).toMatchObject({ countedQuantity: 95, difference: -5, missingQuantity: 5, excessQuantity: 0, damagedQuantity: 2 });
    // Entering a count never moves stock.
    expect(await qty(lock)).toBe(100);
    await submitStocktake(as(store), id, {});
    expect(await qty(lock)).toBe(100);
    s = await approveStocktake(as(manager), id, { note: "ok" });
    expect(s.status).toBe("APPROVED");
    expect(await qty(lock)).toBe(95);
    const adj = await prisma.stockDocument.findFirstOrThrow({ where: { stocktakeId: id } });
    expect(adj.type).toBe("ADJUSTMENT");
    const moves = await prisma.inventoryMovement.findMany({ where: { documentId: adj.id } });
    expect(moves.map((m) => m.quantity.toNumber())).toEqual([-5]);
    // A finalized stocktake cannot be silently changed.
    await expect(saveCounts(as(store), id, { lines: [{ lineId: line.id, countedQuantity: 100, countedSerials: [] }] })).rejects.toThrow();
    await expect(prisma.stocktake.update({ where: { id }, data: { note: "edited" } })).rejects.toThrow(/closed stocktake/);
  });

  it("separation of duties: whoever counted or submitted cannot decide; the setting can turn it off", async () => {
    const id = await plannedSession();
    await startStocktake(as(manager), id);
    const s = await getStocktake(as(manager), id);
    await saveCounts(as(manager), id, { lines: s.lines.map((l) => ({ lineId: l.id, countedQuantity: l.systemQuantity, countedSerials: [] })) });
    await submitStocktake(as(store), id, {});
    await expect(approveStocktake(as(manager), id, {})).rejects.toThrow(ForbiddenError);
    expect((await getStocktake(as(manager), id)).decisionBlocked).toBe("stocktakePlan.errors.ownCount");
    // An approver who did not count may approve; with the setting off the counter could too.
    await approveStocktake(as(manager, { stocktakeIndependentApproval: false }), id, {});
    expect((await getStocktake(as(admin), id)).status).toBe("APPROVED");
  });

  it("a supervisor-only session is approved by its supervisor (or a planner), and a non-approver cannot approve at all", async () => {
    const wm2 = await makeUser("WAREHOUSE_MANAGER", { name: "Other manager" });
    const approverOnly = await makeUser("STORE", { name: "Approver" });
    await prisma.user.update({ where: { id: approverOnly.id }, data: { permissionGrants: ["inventory.approve"] } });
    const ao = await prisma.user.findUniqueOrThrow({ where: { id: approverOnly.id } });
    const id = await plannedSession({ supervisorId: wm2.id });
    await startStocktake(as(store), id);
    const s = await getStocktake(as(store), id);
    await saveCounts(as(store), id, { lines: s.lines.map((l) => ({ lineId: l.id, countedQuantity: l.systemQuantity, countedSerials: [] })) });
    await submitStocktake(as(store), id, {});
    await expect(approveStocktake(as(store2), id, {})).rejects.toBeInstanceOf(ForbiddenError);
    await expect(approveStocktake(as(ao), id, {})).rejects.toThrow(ForbiddenError);
    await approveStocktake(as(wm2), id, {});
  });

  it("a recount keeps every count in the history and must be done before resubmitting", async () => {
    const id = await plannedSession({ categoryIds: [locks] });
    await startStocktake(as(store), id);
    let s = await getStocktake(as(store), id);
    const line = s.lines[0]!;
    await saveCounts(as(store), id, { lines: [{ lineId: line.id, countedQuantity: 90, countedSerials: [], reason: "short" }] });
    await submitStocktake(as(store), id, {});
    await expect(returnForRecount(as(manager), id, {})).rejects.toBeInstanceOf(ValidationError);
    s = await returnForRecount(as(manager), id, { note: "Count the back shelf too", lineIds: [line.id] });
    expect(s.status).toBe("COUNTING");
    expect(s.round).toBe(1);
    expect(s.lines[0]!.recountRequested).toBe(true);
    await expect(submitStocktake(as(store), id, {})).rejects.toThrow(/recount/);
    await saveCounts(as(store2), id, { lines: [{ lineId: line.id, countedQuantity: 100, countedSerials: [] }] });
    s = await getStocktake(as(manager), id);
    expect(s.lines[0]!.history.map((h) => [h.round, h.countedQuantity, h.countedBy.name])).toEqual([
      [0, 90, "Samy Store"],
      [1, 100, "Sara Store"],
    ]);
    await expect(prisma.stocktakeCount.updateMany({ where: { stocktakeId: id }, data: { reason: "x" } })).rejects.toThrow(/append-only/);
    await submitStocktake(as(store2), id, {});
    await approveStocktake(as(manager), id, {});
    expect(await qty(lock)).toBe(100);
  });

  it("unauthorized people cannot count, adjust or plan; photos must be images", async () => {
    const id = await plannedSession();
    // Outside their scope: looks exactly like a missing record.
    await expect(startStocktake(as(tech), id)).rejects.toBeInstanceOf(NotFoundError);
    await startStocktake(as(store), id);
    await expect(approveStocktake(as(store), id, {})).rejects.toBeInstanceOf(ForbiddenError);
    const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
    const photo = await uploadStocktakePhoto(as(store), id, null, png);
    expect(photo.url).toMatch(/\/api\/stocktake-photos\//);
    await expect(uploadStocktakePhoto(as(store), id, null, new TextEncoder().encode("not an image"))).rejects.toBeInstanceOf(ValidationError);
    expect((await getStocktake(as(store), id)).photos).toHaveLength(1);
  });

  it("an ad-hoc stocktake can be scoped too, and the dashboard shows overdue, pending and discrepancies", async () => {
    const adhoc = await createStocktake(as(store), { warehouseId: main, productIds: [cable], name: "Cable spot check" });
    let s = await getStocktake(as(store), adhoc.id);
    expect(s.lines.map((l) => l.product.sku)).toEqual(["CBL-1"]);
    await saveCounts(as(store), adhoc.id, { lines: [{ lineId: s.lines[0]!.id, countedQuantity: 48, countedSerials: [], reason: "cut pieces" }] });
    await submitStocktake(as(store), adhoc.id, {});
    let d = await stocktakeDashboard(as(manager), {});
    expect(d.pendingApproval.map((x) => x.id)).toEqual([adhoc.id]);
    await approveStocktake(as(manager), adhoc.id, {});
    // A planned session that should have started already is overdue.
    await createSchedule(as(manager), { name: "Missed", warehouseId: main, kind: "CUSTOM", recurrence: "NONE", interval: 1, startDate: day, endDate: null, startTime: "00:00", durationMinutes: 15, supervisorId: null });
    d = await stocktakeDashboard(as(manager), {});
    expect(d.overdue.map((x) => x.name)).toContain("Missed");
    expect(d.discrepancies.map((x) => [x.product.sku, x.difference])).toEqual([["CBL-1", -2]]);
    expect(d.warehouses[0]!.completed).toBe(1);
    s = await getStocktake(as(manager), adhoc.id);
    expect(s.status).toBe("APPROVED");
    await expect(stocktakeDashboard(as(tech), {})).rejects.toThrow();
  });
});
