import { beforeEach, describe, expect, it } from "vitest";
import type { User } from "@prisma/client";
import { saveProduct } from "@/server/services/inventory-catalog";
import { saveBin, saveWarehouse } from "@/server/services/inventory-warehouses";
import { createDocument, getDocument } from "@/server/services/inventory-documents";
import { addStocktakeLine, approveStocktake, cancelStocktake, createStocktake, getStocktake, listStocktakes, rejectStocktake, saveCounts, submitStocktake } from "@/server/services/stocktakes";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { DEFAULT_TIMEZONE } from "@/lib/constants";
import { todayKey } from "@/lib/time";
import { asCurrent, makeUser, prisma, resetDb } from "../helpers";

/**
 * Physical stocktaking: snapshot and freeze, counting (with serial numbers), submission with
 * explanations, approval that posts one adjustment, rejection and cancellation, and who may do what.
 */
const day = todayKey(DEFAULT_TIMEZONE);

let manager: User, store: User, tech: User, sales: User;
let main: string, side: string, shelf: string;
let lock: string, cable: string, hub: string;

beforeEach(async () => {
  await resetDb();
  manager = await makeUser("WAREHOUSE_MANAGER", { name: "Wael Manager" });
  store = await makeUser("STORE", { name: "Samy Store" });
  tech = await makeUser("TECHNICIAN");
  sales = await makeUser("SALES");
  const m = asCurrent(manager);
  main = (await saveWarehouse(m, null, { code: "MAIN", nameEn: "Main store", nameAr: "المخزن الرئيسي", kind: "WAREHOUSE" })).id;
  side = (await saveWarehouse(m, null, { code: "SIDE", nameEn: "Branch", nameAr: "الفرع", kind: "WAREHOUSE" })).id;
  shelf = (await saveBin(m, main, null, { code: "A-1" })).id;
  lock = (await saveProduct(m, null, { sku: "LK-1", nameEn: "Lock", nameAr: "قفل", unitId: "unit-pcs", purchaseCost: 1000, trackSerials: true })).id;
  cable = (await saveProduct(m, null, { sku: "CBL-1", nameEn: "Cable", nameAr: "سلك", unitId: "unit-m", purchaseCost: 10 })).id;
  hub = (await saveProduct(m, null, { sku: "HUB-1", nameEn: "Hub", nameAr: "هاب", unitId: "unit-pcs", purchaseCost: 500 })).id;
  await createDocument(
    asCurrent(store),
    { type: "RECEIPT", toWarehouseId: main, documentDate: day, lines: [{ productId: lock, quantity: 3, serials: "S1\nS2\nS3" }, { productId: cable, quantity: 50, toBinId: shelf }, { productId: hub, quantity: 4 }] },
    { post: true },
  );
});

const as = (u: User) => asCurrent(u);
async function qty(productId: string, warehouseId = main, binId: string | null = null) {
  const b = await prisma.stockBalance.findUnique({ where: { productId_warehouseId_binKey: { productId, warehouseId, binKey: binId ?? "" } } });
  return b ? b.quantity.toNumber() : 0;
}
const lineOf = (s: Awaited<ReturnType<typeof getStocktake>>, productId: string) => s.lines.find((l) => l.product.id === productId)!;

describe("starting a stocktake", () => {
  it("snapshots the system quantities and serials, and allows one open stocktake per warehouse", async () => {
    const { id, number } = await createStocktake(as(store), { warehouseId: main });
    expect(number).toMatch(/^STK-\d{4}-000001$/);
    const s = await getStocktake(as(store), id);
    expect(s.status).toBe("COUNTING");
    expect(s.lines.map((l) => [l.product.sku, l.bin, l.systemQuantity])).toEqual([
      ["CBL-1", "A-1", 50],
      ["HUB-1", null, 4],
      ["LK-1", null, 3],
    ]);
    expect(lineOf(s, lock).systemSerials).toEqual(["S1", "S2", "S3"]);
    await expect(createStocktake(as(store), { warehouseId: main })).rejects.toThrow(/already open/);
    // Another warehouse can be counted at the same time.
    await createStocktake(as(store), { warehouseId: side });
    expect((await listStocktakes(as(manager), {})).total).toBe(2);
  });

  it("freezes the warehouse: no document can move its stock until the stocktake closes", async () => {
    const { id } = await createStocktake(as(store), { warehouseId: main });
    const e = await createDocument(as(store), { type: "ISSUE", fromWarehouseId: main, documentDate: day, lines: [{ productId: hub, quantity: 1 }] }, { post: true }).catch((x) => x);
    expect(e).toBeInstanceOf(ValidationError);
    expect(e.message).toMatch(/being counted/);
    expect(await qty(hub)).toBe(4);
    // A draft can still be prepared; it just cannot be posted yet.
    const draft = await createDocument(as(store), { type: "TRANSFER", fromWarehouseId: main, toWarehouseId: side, documentDate: day, lines: [{ productId: hub, quantity: 1 }] });
    await cancelStocktake(as(store), id, {});
    await expect(getDocument(as(store), draft.id)).resolves.toMatchObject({ status: "DRAFT" });
    await createDocument(as(store), { type: "ISSUE", fromWarehouseId: main, documentDate: day, lines: [{ productId: hub, quantity: 1 }] }, { post: true });
    expect(await qty(hub)).toBe(3);
  });
});

describe("counting, submitting and approving", () => {
  it("requires every line counted and every difference explained, then posts one adjustment on approval", async () => {
    const { id } = await createStocktake(as(store), { warehouseId: main });
    let s = await getStocktake(as(store), id);
    // Counts can be saved in parts.
    s = await saveCounts(as(store), id, { lines: [{ lineId: lineOf(s, cable).id, countedQuantity: "47.5" }] });
    expect(lineOf(s, cable).difference).toBe(-2.5);
    await expect(submitStocktake(as(store), id, {})).rejects.toThrow(/not counted yet/);

    s = await saveCounts(as(store), id, {
      lines: [
        { lineId: lineOf(s, hub).id, countedQuantity: 5, reason: "One was on the wrong shelf" },
        // S2 is missing, S9 was found instead: same count, different units.
        { lineId: lineOf(s, lock).id, countedSerials: "S1\nS3\nS9" },
      ],
    });
    expect(lineOf(s, lock).countedQuantity).toBe(3);
    const unexplained = await submitStocktake(as(store), id, {}).catch((x) => x);
    expect(unexplained.message).toMatch(/2 differences have no explanation/);
    s = await saveCounts(as(store), id, {
      lines: [
        { lineId: lineOf(s, cable).id, countedQuantity: 47.5, reason: "Offcuts used" },
        { lineId: lineOf(s, lock).id, countedSerials: ["S1", "S3", "S9"], reason: "S2 missing, S9 unregistered" },
      ],
    });
    s = await submitStocktake(as(store), id, {});
    expect(s.status).toBe("SUBMITTED");
    expect(s.submittedBy?.name).toBe("Samy Store");
    // Counts are locked once submitted.
    await expect(saveCounts(as(store), id, { lines: [{ lineId: lineOf(s, hub).id, countedQuantity: 9 }] })).rejects.toThrow(/Awaiting approval/);

    // The store keeper cannot approve their own count; the manager can.
    await expect(approveStocktake(as(store), id, {})).rejects.toBeInstanceOf(ForbiddenError);
    s = await approveStocktake(as(manager), id, { note: "OK" });
    expect(s.status).toBe("APPROVED");
    expect(s.decidedBy?.name).toBe("Wael Manager");
    expect(s.adjustment?.number).toMatch(/^ADJ-/);
    expect([await qty(cable, main, shelf), await qty(hub), await qty(lock)]).toEqual([47.5, 5, 3]);
    const serials = await prisma.productSerial.findMany({ where: { productId: lock }, orderBy: { serial: "asc" }, select: { serial: true, warehouseId: true } });
    expect(serials).toEqual([
      { serial: "S1", warehouseId: main },
      { serial: "S2", warehouseId: null },
      { serial: "S3", warehouseId: main },
      { serial: "S9", warehouseId: main },
    ]);
    const adj = await getDocument(as(manager), s.adjustment!.id);
    expect(adj.stocktake?.number).toBe(s.number);
    expect(adj.lines.map((l) => [l.product.sku, l.direction, l.quantity])).toEqual([
      ["CBL-1", "DECREASE", 2.5],
      ["HUB-1", "INCREASE", 1],
      ["LK-1", "DECREASE", 1],
      ["LK-1", "INCREASE", 1],
    ]);
    // Approving again changes nothing; the warehouse is no longer frozen.
    await approveStocktake(as(manager), id, {});
    expect(await prisma.stockDocument.count({ where: { stocktakeId: id } })).toBe(1);
    await createDocument(as(store), { type: "ISSUE", fromWarehouseId: main, documentDate: day, lines: [{ productId: hub, quantity: 1 }] }, { post: true });
    // A closed stocktake cannot change, even directly in the database.
    await expect(prisma.stocktake.update({ where: { id }, data: { note: "x" } })).rejects.toThrow(/closed stocktake/);
    // Every step is in the audit log with who did it.
    const actions = await prisma.auditLog.findMany({ where: { entityId: id }, orderBy: { createdAt: "asc" }, select: { action: true, actorId: true } });
    expect(actions).toEqual([
      { action: "STOCKTAKE_STARTED", actorId: store.id },
      { action: "STOCKTAKE_SUBMITTED", actorId: store.id },
      { action: "STOCKTAKE_APPROVED", actorId: manager.id },
    ]);
  });

  it("adds a product found during the count and approves without a document when nothing differs", async () => {
    const extra = (await saveProduct(as(manager), null, { sku: "EXTRA", nameEn: "Extra", nameAr: "زيادة", unitId: "unit-pcs", purchaseCost: 5 })).id;
    const { id } = await createStocktake(as(store), { warehouseId: side });
    let s = await getStocktake(as(store), id);
    expect(s.lines).toHaveLength(0);
    s = await addStocktakeLine(as(store), id, { productId: extra });
    await expect(addStocktakeLine(as(store), id, { productId: extra })).rejects.toBeInstanceOf(ValidationError);
    s = await saveCounts(as(store), id, { lines: [{ lineId: s.lines[0]!.id, countedQuantity: 0 }] });
    await submitStocktake(as(store), id, {});
    s = await approveStocktake(as(manager), id, {});
    expect(s.status).toBe("APPROVED");
    expect(s.adjustment).toBeNull();
  });

  it("rejects with a reason without touching stock, and lets a count be cancelled", async () => {
    const { id } = await createStocktake(as(store), { warehouseId: main });
    let s = await getStocktake(as(store), id);
    s = await saveCounts(as(store), id, { lines: s.lines.map((l) => ({ lineId: l.id, countedQuantity: l.systemQuantity, countedSerials: l.systemSerials })) });
    await submitStocktake(as(store), id, {});
    await expect(rejectStocktake(as(manager), id, {})).rejects.toMatchObject({ fieldErrors: { note: expect.any(String) } });
    s = await rejectStocktake(as(manager), id, { note: "Count again with two people" });
    expect(s.status).toBe("REJECTED");
    expect(await prisma.stockDocument.count({ where: { type: "ADJUSTMENT" } })).toBe(0);
    // A new count can start right away.
    const next = await createStocktake(as(store), { warehouseId: main });
    expect((await cancelStocktake(as(store), next.id, { note: "Started by mistake" })).status).toBe("CANCELLED");
  });
});

describe("access", () => {
  it("is for people who count and approve; technicians and sales cannot see it", async () => {
    const { id } = await createStocktake(as(store), { warehouseId: main });
    await expect(createStocktake(as(tech), { warehouseId: side })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getStocktake(as(sales), id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(listStocktakes(as(tech), {})).rejects.toBeInstanceOf(NotFoundError);
  });
});
