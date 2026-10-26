import { beforeEach, describe, expect, it } from "vitest";
import type { User } from "@prisma/client";
import { createAppointment, getAppointment, getAppointmentHistory, recordVisitOutcome, updateAppointment } from "@/server/services/appointments";
import { Prisma } from "@prisma/client";
import { amountDue, financeCsv, financeStatement, receiveCash } from "@/server/services/payments";
import { listNotifications } from "@/server/services/notifications";
import { listAuditLog } from "@/server/services/audit-log";
import { ForbiddenError, ValidationError } from "@/server/errors";
import { appointmentPayload, asCurrent, makeUser, prisma, resetDb, seedStatuses } from "../helpers";

let admin: User, sales: User, tech: User, otherTech: User, accountant: User, viewer: User;

beforeEach(async () => {
  await resetDb();
  await seedStatuses();
  admin = await makeUser("ADMIN");
  sales = await makeUser("SALES");
  tech = await makeUser("TECHNICIAN");
  otherTech = await makeUser("TECHNICIAN");
  accountant = await makeUser("ACCOUNTANT");
  viewer = await makeUser("VIEWER", { viewerPermissions: ["appointments.view", "history.view"] });
});

const priced = (overrides: Record<string, unknown> = {}) =>
  createAppointment(asCurrent(sales), appointmentPayload({ technicianIds: [tech.id], totalPrice: "4,500", depositAmount: 1500, depositMethod: "INSTAPAY", ...overrides }));

async function finish(id: string, collectedAmount: unknown, collectedMethod: string | null = "CASH", user = tech) {
  return recordVisitOutcome(asCurrent(user), id, { outcome: "COMPLETED", report: "Installed.", collectedAmount, collectedMethod });
}

describe("prices on a booking", () => {
  it("works out the amount due exactly, without floating-point drift", () => {
    const d = (v: string | null) => (v === null ? null : new Prisma.Decimal(v));
    expect(amountDue({ totalPrice: d("0.30"), depositAmount: d("0.10"), extraFee: d("0.20") })).toBe(0.4);
    expect(amountDue({ totalPrice: d("1000.10"), depositAmount: d("1000.20"), extraFee: d("5.05") })).toBe(5.05);
    expect(amountDue({ totalPrice: null, depositAmount: null, extraFee: null })).toBeNull();
  });

  it("stores price, deposit and extra fee, and works out what to collect", async () => {
    const a = await priced({ extraFee: 250 });
    expect(a.payment).toMatchObject({ totalPrice: 4500, depositAmount: 1500, depositMethod: "INSTAPAY", extraFee: 250, due: 3250, collectedAmount: null, balance: 3250 });
    // An edit that does not send the money fields keeps them (the payload helper has none).
    const kept = await updateAppointment(asCurrent(sales), a.id, appointmentPayload({ technicianIds: [tech.id], brand: "Samsung", version: a.version }));
    expect(kept.payment).toMatchObject({ totalPrice: 4500, depositAmount: 1500, extraFee: 250 });
    const changed = await updateAppointment(asCurrent(sales), a.id, appointmentPayload({ technicianIds: [tech.id], version: kept.version, totalPrice: 5000, depositAmount: 1500, depositMethod: "INSTAPAY" }));
    expect(changed.payment?.due).toBe(3750);
    const history = await getAppointmentHistory(asCurrent(sales), a.id);
    expect(history[0]?.changes).toMatchObject({ totalPrice: { from: 4500, to: 5000 } });
    // Viewers allowed to read the history still do not see amounts.
    expect((await getAppointmentHistory(asCurrent(viewer), a.id))[0]?.changes).toMatchObject({ totalPrice: { from: "(hidden)", to: "(hidden)" } });
  });

  it("validates the amounts", async () => {
    await expect(priced({ totalPrice: "" })).rejects.toBeInstanceOf(ValidationError); // deposit without a price
    await expect(priced({ depositAmount: 9000 })).rejects.toBeInstanceOf(ValidationError);
    await expect(priced({ depositMethod: null })).rejects.toBeInstanceOf(ValidationError);
    await expect(priced({ totalPrice: -1 })).rejects.toBeInstanceOf(ValidationError);
    await expect(priced({ totalPrice: "12.345" })).rejects.toBeInstanceOf(ValidationError);
    const a = await priced();
    // Lowering the price below the kept deposit is refused instead of hitting the database check.
    await expect(updateAppointment(asCurrent(sales), a.id, appointmentPayload({ technicianIds: [tech.id], version: a.version, totalPrice: 1000 }))).rejects.toThrow(
      /deposit cannot be more/,
    );
    expect(await prisma.appointment.count()).toBe(1);
  });

  it("shows the price only to people who manage bookings or the finances", async () => {
    const a = await priced();
    expect((await getAppointment(asCurrent(accountant), a.id)).payment?.totalPrice).toBe(4500);
    const forTech = (await getAppointment(asCurrent(tech), a.id)).payment!;
    expect(forTech.due).toBe(3000);
    expect(forTech).not.toHaveProperty("totalPrice");
    expect(forTech).not.toHaveProperty("depositAmount");
    expect(forTech).not.toHaveProperty("custody");
    expect((await getAppointment(asCurrent(viewer), a.id)).payment).toBeNull();
  });
});

describe("collecting at the visit and cash custody", () => {
  it("keeps cash with the technician until the accountant receives it", async () => {
    const a = await priced();
    await expect(finish(a.id, 3500)).rejects.toThrow(/more than the amount due/);
    await expect(finish(a.id, 3000, null)).rejects.toBeInstanceOf(ValidationError);
    await expect(recordVisitOutcome(asCurrent(tech), a.id, { outcome: "IN_PROGRESS", collectedAmount: 100, collectedMethod: "CASH" })).rejects.toBeInstanceOf(ValidationError);

    const done = await finish(a.id, 2500);
    expect(done.payment).toMatchObject({ collectedAmount: 2500, collectedMethod: "CASH", balance: 500, collectedBy: { id: tech.id } });
    const forSales = await getAppointment(asCurrent(sales), a.id);
    expect(forSales.payment?.custody).toMatchObject({ status: "HELD", holder: { id: tech.id } });
    expect((await listNotifications(asCurrent(sales))).items[0]?.message).toMatch(/collected 2,500 EGP \(Cash\)/);

    // A correction before the hand-over updates the custody; a non-cash payment voids it.
    await finish(a.id, 3000);
    expect((await prisma.cashCustody.findUniqueOrThrow({ where: { appointmentId: a.id } })).amount.toNumber()).toBe(3000);
    await finish(a.id, 3000, "VODAFONE_CASH");
    expect((await prisma.cashCustody.findUniqueOrThrow({ where: { appointmentId: a.id } })).status).toBe("VOID");
    await finish(a.id, 3000, "CASH");
    expect((await prisma.cashCustody.findUniqueOrThrow({ where: { appointmentId: a.id } })).status).toBe("HELD");

    await expect(receiveCash(asCurrent(sales), { technicianId: tech.id })).rejects.toBeInstanceOf(ForbiddenError);
    const got = await receiveCash(asCurrent(accountant), { technicianId: tech.id });
    expect(got).toEqual({ amount: 3000, count: 1 });
    expect((await getAppointment(asCurrent(admin), a.id)).payment?.custody).toMatchObject({ status: "RECEIVED", receivedBy: { id: accountant.id } });
    expect((await listNotifications(asCurrent(tech))).items[0]).toMatchObject({ type: "CASH_RECEIVED" });
    expect((await listAuditLog(asCurrent(admin), { entityType: "CASH" })).items[0]).toMatchObject({ action: "CASH_RECEIVED" });

    // Once handed over it cannot be changed from the field, and there is nothing left to receive.
    await expect(finish(a.id, 2000)).rejects.toThrow(/already handed over/);
    await expect(receiveCash(asCurrent(accountant), { technicianId: tech.id })).rejects.toThrow(/not holding any cash/);
  });

  it("receives only the chosen visits and refuses stale choices", async () => {
    const a = await priced();
    const b = await priced({ date: "2030-03-11" });
    await finish(a.id, 3000);
    await finish(b.id, 1000);
    const entryA = await prisma.cashCustody.findUniqueOrThrow({ where: { appointmentId: a.id } });
    expect(await receiveCash(asCurrent(accountant), { technicianId: tech.id, entryIds: [entryA.id] })).toEqual({ amount: 3000, count: 1 });
    await expect(receiveCash(asCurrent(accountant), { technicianId: tech.id, entryIds: [entryA.id] })).rejects.toThrow(/already received/);
    const statement = await financeStatement(asCurrent(accountant), "2030-03");
    expect(statement.holdings).toEqual([expect.objectContaining({ technicianId: tech.id, amount: 1000, visits: 1 })]);
  });

  it("puts cash with the office when a manager records it on a visit nobody is assigned to", async () => {
    const a = await priced({ technicianIds: [] });
    const done = await finish(a.id, 3000, "CASH", sales);
    expect((await getAppointment(asCurrent(sales), done.id)).payment?.custody).toMatchObject({ status: "RECEIVED", holder: { id: sales.id } });
  });

  it("does not let other technicians record a payment", async () => {
    const a = await priced();
    await expect(finish(a.id, 100, "CASH", otherTech)).rejects.toThrow();
  });
});

describe("monthly finance statement", () => {
  it("adds up prices, deposits, collections by method, balances owed and cash held", async () => {
    const a = await priced(); // due 3000
    const b = await priced({ date: "2030-03-12", totalPrice: 2000, depositAmount: "", depositMethod: null, extraFee: 300 }); // due 2300
    await priced({ date: "2030-04-02" }); // another month
    await finish(a.id, 3000);
    await finish(b.id, 1300, "BANK_TRANSFER");

    const s = await financeStatement(asCurrent(accountant), "2030-03");
    expect(s).toMatchObject({ visits: 2, totalSales: 6500, deposits: 1500, collected: 4300, fees: 300, owedTotal: 1000, owedCount: 1, cashHeld: 3000 });
    expect(s.depositsByMethod).toEqual([{ method: "INSTAPAY", amount: 1500 }]);
    expect(s.collectedByMethod).toEqual([
      { method: "CASH", amount: 3000 },
      { method: "BANK_TRANSFER", amount: 1300 },
    ]);
    expect(s.owed).toEqual([expect.objectContaining({ id: b.id, due: 2300, collected: 1300, balance: 1000, phone: expect.any(String) })]);

    const csv = await financeCsv(asCurrent(accountant), "2030-03");
    const lines = csv.trim().split("\r\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("Total price,Deposit,Deposit method,Extra fee,Due at visit,Collected,Collected method,Balance");
    expect(lines.find((l) => l.startsWith(b.code))).toContain("2000,,,300,2300,1300,Bank transfer,1000");

    // The same export for an Arabic reader: translated headings and labels, unchanged numbers.
    const ar = (await financeCsv(asCurrent(accountant), "2030-03", "ar")).trim().split("\r\n");
    expect(ar[0]).toContain("السعر الإجمالي,العربون");
    expect(ar.find((l) => l.startsWith(b.code))).toContain("2000,,,300,2300,1300,تحويل بنكي,1000");

    await expect(financeStatement(asCurrent(sales), "2030-03")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(financeStatement(asCurrent(tech), "2030-03")).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("gives the accountant read-only access to bookings", async () => {
    const a = await priced();
    expect((await getAppointment(asCurrent(accountant), a.id)).canManage).toBe(false);
    await expect(createAppointment(asCurrent(accountant), appointmentPayload())).rejects.toBeInstanceOf(ForbiddenError);
    await expect(finish(a.id, 100, "CASH", accountant)).rejects.toBeInstanceOf(ForbiddenError);
  });
});
