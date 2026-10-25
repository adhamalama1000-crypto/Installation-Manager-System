import { beforeEach, describe, expect, it } from "vitest";
import type { User } from "@prisma/client";
import { createAppointment, getAppointment, getAppointmentHistory, recordVisitOutcome } from "@/server/services/appointments";
import { itemHistory, moveStock, saveModel, stockIn, stockOverview } from "@/server/services/stock";
import { listNotifications } from "@/server/services/notifications";
import { listAuditLog } from "@/server/services/audit-log";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { appointmentPayload, asCurrent, makeUser, prisma, resetDb, seedStatuses } from "../helpers";

let admin: User, sales: User, tech: User, otherTech: User, store: User, accountant: User;
let lockModel: string;

beforeEach(async () => {
  await resetDb();
  await seedStatuses();
  admin = await makeUser("ADMIN");
  sales = await makeUser("SALES");
  tech = await makeUser("TECHNICIAN");
  otherTech = await makeUser("TECHNICIAN");
  store = await makeUser("STORE");
  accountant = await makeUser("ACCOUNTANT");
  lockModel = (await saveModel(asCurrent(store), null, { name: "Philips 9300", category: "SMART_LOCK", warrantyMonths: 24 })).id;
});

const idsOf = async (serials: string[]) => (await prisma.stockItem.findMany({ where: { serial: { in: serials } }, orderBy: { serial: "asc" } })).map((i) => i.id);

async function handTo(technician: User, serials: string[]) {
  return moveStock(asCurrent(store), { itemIds: await idsOf(serials), to: "WITH_TECHNICIAN", technicianId: technician.id });
}

describe("models and goods in", () => {
  it("keeps model names unique regardless of case and only lets the store manage them", async () => {
    await expect(saveModel(asCurrent(store), null, { name: "  philips   9300 ", category: "SMART_LOCK", warrantyMonths: 12 })).rejects.toBeInstanceOf(ValidationError);
    await expect(saveModel(asCurrent(tech), null, { name: "K02", category: "SMART_LOCK", warrantyMonths: 12 })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(saveModel(asCurrent(store), null, { name: "Hub", category: "SMART_HOME", warrantyMonths: 200 })).rejects.toBeInstanceOf(ValidationError);
    await saveModel(asCurrent(store), lockModel, { name: "Philips 9300", category: "SMART_LOCK", warrantyMonths: 18 });
    expect((await prisma.productModel.findUniqueOrThrow({ where: { id: lockModel } })).warrantyMonths).toBe(18);
  });

  it("registers serials one per line, normalised, and refuses duplicates", async () => {
    expect(await stockIn(asCurrent(store), { modelId: lockModel, serials: "ph-001\n ph 002 ,PH-003\nph-001", note: "Invoice 77" })).toEqual({ count: 3 });
    expect((await prisma.stockItem.findMany()).map((i) => [i.serial, i.status]).sort()).toEqual([
      ["PH-001", "IN_STORE"],
      ["PH-003", "IN_STORE"],
      ["PH002", "IN_STORE"],
    ]);
    await expect(stockIn(asCurrent(store), { modelId: lockModel, serials: "PH-004\nph-003" })).rejects.toThrow(/Already registered: PH-003/);
    expect(await prisma.stockItem.count()).toBe(3);
    await expect(stockIn(asCurrent(store), { modelId: lockModel, serials: "bad serial!" })).rejects.toBeInstanceOf(ValidationError);
    expect((await listAuditLog(asCurrent(admin), { entityType: "STOCK" })).items[0]).toMatchObject({ action: "STOCK_IN", summary: "Goods in: 3 × Philips 9300" });
    expect(await prisma.stockMovement.count()).toBe(3);
  });
});

describe("custody", () => {
  beforeEach(async () => {
    await stockIn(asCurrent(store), { modelId: lockModel, serials: "PH-001\nPH-002\nPH-003" });
  });

  it("hands items to a technician and takes them back, notifying the technician", async () => {
    expect(await handTo(tech, ["PH-001", "PH-002"])).toEqual({ count: 2 });
    expect((await listNotifications(asCurrent(tech))).items[0]).toMatchObject({ type: "STOCK_HANDED" });
    // Technicians see only their own custody; the accountant sees everything read-only.
    expect((await stockOverview(asCurrent(tech), {})).items.map((i) => i.serial).sort()).toEqual(["PH-001", "PH-002"]);
    expect((await stockOverview(asCurrent(otherTech), {})).items).toEqual([]);
    const all = await stockOverview(asCurrent(accountant), { status: "IN_STORE" });
    expect(all.items.map((i) => i.serial)).toEqual(["PH-003"]);
    expect(all.summary).toEqual([{ modelId: lockModel, name: "Philips 9300", counts: { IN_STORE: 1, WITH_TECHNICIAN: 2 } }]);
    await expect(moveStock(asCurrent(accountant), { itemIds: await idsOf(["PH-003"]), to: "FAULTY" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(moveStock(asCurrent(store), { itemIds: await idsOf(["PH-003"]), to: "WITH_TECHNICIAN", technicianId: sales.id })).rejects.toBeInstanceOf(ValidationError);

    await moveStock(asCurrent(store), { itemIds: await idsOf(["PH-002"]), to: "IN_STORE", note: "Not needed" });
    expect((await listNotifications(asCurrent(tech))).items[0]).toMatchObject({ type: "STOCK_TAKEN" });
    const history = await itemHistory(asCurrent(store), "ph-002");
    expect(history.movements.map((m) => [m.fromStatus, m.toStatus, m.holder])).toEqual([
      ["WITH_TECHNICIAN", "IN_STORE", null],
      ["IN_STORE", "WITH_TECHNICIAN", tech.name],
      [null, "IN_STORE", null],
    ]);
    await expect(itemHistory(asCurrent(tech), "PH-002")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("keeps the movement history append-only", async () => {
    const move = await prisma.stockMovement.findFirstOrThrow();
    await expect(prisma.stockMovement.update({ where: { id: move.id }, data: { note: "x" } })).rejects.toThrow(/append-only/);
    await expect(prisma.stockMovement.delete({ where: { id: move.id } })).rejects.toThrow(/append-only/);
  });
});

describe("installing at the visit", () => {
  beforeEach(async () => {
    await stockIn(asCurrent(store), { modelId: lockModel, serials: "PH-001\nPH-002\nPH-003\nPH-004" });
    await handTo(tech, ["PH-001", "PH-002"]);
    await handTo(otherTech, ["PH-003"]);
  });

  const book = (overrides: Record<string, unknown> = {}) => createAppointment(asCurrent(sales), appointmentPayload({ technicianIds: [tech.id], ...overrides }));
  const finish = (user: User, id: string, serials: string) => recordVisitOutcome(asCurrent(user), id, { outcome: "COMPLETED", report: "Installed.", serials });

  it("installs the technician's own items and starts the warranty on the visit date", async () => {
    const a = await book(); // 2030-03-10
    const done = await finish(tech, a.id, "ph-001");
    expect(done.installed).toEqual([{ serial: "PH-001", model: "Philips 9300", warrantyUntil: "2032-03-10" }]);
    const item = await prisma.stockItem.findUniqueOrThrow({ where: { serial: "PH-001" } });
    expect(item).toMatchObject({ status: "INSTALLED", holderId: null, appointmentId: a.id });
    expect((await stockOverview(asCurrent(tech), {})).items.map((i) => i.serial)).toEqual(["PH-002"]);
    expect((await getAppointment(asCurrent(sales), a.id)).installed).toHaveLength(1);
    expect((await getAppointmentHistory(asCurrent(sales), a.id))[0]?.changes).toMatchObject({ installedSerials: { from: null, to: ["PH-001"] } });
    // Sending the same serial again is harmless.
    await finish(tech, a.id, "PH-001");
    expect(await prisma.stockMovement.count({ where: { toStatus: "INSTALLED" } })).toBe(1);
  });

  it("refuses items that are not in the technician's custody, unknown, installed elsewhere or faulty", async () => {
    const a = await book();
    await expect(finish(tech, a.id, "PH-003")).rejects.toThrow(/not in your custody \(with /);
    await expect(finish(tech, a.id, "PH-004")).rejects.toThrow(/not in your custody \(in the store\)/);
    await expect(finish(tech, a.id, "NOPE-1")).rejects.toThrow(/Not in stock: NOPE-1/);
    await expect(recordVisitOutcome(asCurrent(tech), a.id, { outcome: "NEEDS_REVISIT", report: "x", serials: "PH-001" })).rejects.toBeInstanceOf(ValidationError);
    const b = await book({ date: "2030-03-11" });
    await finish(tech, b.id, "PH-001");
    await expect(finish(tech, a.id, "PH-001")).rejects.toThrow(/already installed on APT-/);
    await moveStock(asCurrent(store), { itemIds: await idsOf(["PH-002"]), to: "FAULTY" });
    await expect(finish(tech, a.id, "PH-002")).rejects.toThrow(/marked faulty/);
    // Nothing was half-applied: the visit is still open.
    expect((await getAppointment(asCurrent(sales), a.id)).status.kind).toBe("SCHEDULED");
  });

  it("lets whoever manages the booking install straight from the store, and the store swap a faulty unit", async () => {
    const a = await book();
    await finish(sales, a.id, "PH-004");
    expect((await prisma.stockItem.findUniqueOrThrow({ where: { serial: "PH-004" } })).appointmentId).toBe(a.id);
    // An installed item cannot simply go back to the store...
    await expect(moveStock(asCurrent(store), { itemIds: await idsOf(["PH-004"]), to: "IN_STORE" })).rejects.toThrow(/installed/);
    // ...but can be marked faulty (warranty swap); the history keeps the visit.
    await moveStock(asCurrent(store), { itemIds: await idsOf(["PH-004"]), to: "FAULTY", note: "Motor failure" });
    expect(await prisma.stockItem.findUniqueOrThrow({ where: { serial: "PH-004" } })).toMatchObject({ status: "FAULTY", appointmentId: null, warrantyUntil: null });
    expect((await itemHistory(asCurrent(store), "PH-004")).movements[0]).toMatchObject({ fromStatus: "INSTALLED", toStatus: "FAULTY", appointment: { id: a.id } });
  });
});
