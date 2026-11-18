import { beforeEach, describe, expect, it } from "vitest";
import type { User } from "@prisma/client";
import { createAppointment, recordVisitOutcome } from "@/server/services/appointments";
import { operationsOverview } from "@/server/services/dashboard-operations";
import { appointmentPayload, asCurrent, makeUser, prisma, resetDb, seedStatuses } from "../helpers";

/** The OR VIP dashboard panels: what each role sees, and that the figures add up. */

let admin: User, sales: User, tech: User, lateTech: User, leaveTech: User, absentTech: User, accountant: User;
// The appointment payload books 2030-03-10 10:00 company time; "now" is that morning.
const NOW = new Date("2030-03-10T07:00:00Z");
const DAY = new Date("2030-03-10T00:00:00Z");

beforeEach(async () => {
  await resetDb();
  await seedStatuses();
  admin = await makeUser("ADMIN");
  sales = await makeUser("SALES");
  tech = await makeUser("TECHNICIAN");
  lateTech = await makeUser("TECHNICIAN");
  leaveTech = await makeUser("TECHNICIAN");
  absentTech = await makeUser("TECHNICIAN");
  accountant = await makeUser("ACCOUNTANT");
  await makeUser("TECHNICIAN", { isActive: false }); // inactive staff are not counted
});

describe("operations overview", () => {
  it("counts today's attendance by state", async () => {
    await prisma.checkIn.createMany({
      data: [
        { userId: tech.id, kind: "COMPANY", day: DAY },
        { userId: lateTech.id, kind: "COMPANY", day: DAY, lateMinutes: 25 },
        // A second clock-in the same day does not count the person twice.
        { userId: lateTech.id, kind: "COMPANY", day: DAY },
      ],
    });
    await prisma.technicianLeave.create({
      data: { userId: leaveTech.id, startDate: DAY, endDate: DAY, type: "LEAVE", status: "APPROVED", requestedById: leaveTech.id },
    });
    const { attendance } = await operationsOverview(asCurrent(admin), NOW);
    expect(attendance).toEqual({ staff: 4, onTime: 1, late: 1, onLeave: 1, notIn: 1 });
    expect(absentTech.id).toBeTruthy();
  });

  it("adds up today's visits, cash held and pending approvals", async () => {
    const a = await createAppointment(asCurrent(sales), appointmentPayload({ technicianIds: [tech.id], totalPrice: 4500, depositAmount: 1500, depositMethod: "INSTAPAY" }));
    await createAppointment(asCurrent(sales), appointmentPayload({ technicianIds: [lateTech.id], startTime: "14:00" }));
    await recordVisitOutcome(asCurrent(tech), a.id, { outcome: "COMPLETED", report: "Installed.", collectedAmount: 3000, collectedMethod: "CASH" });
    await prisma.technicianLeave.create({
      data: { userId: tech.id, startDate: new Date("2030-04-01T00:00:00Z"), endDate: new Date("2030-04-02T00:00:00Z"), type: "LEAVE", status: "REQUESTED", requestedById: tech.id },
    });
    await prisma.transportExpense.createMany({
      data: [
        { userId: tech.id, day: DAY, amount: 50, status: "PENDING" },
        { userId: tech.id, day: DAY, amount: 70, status: "PAID", paidAt: NOW, paidById: accountant.id },
      ],
    });

    const ops = await operationsOverview(asCurrent(admin), NOW);
    expect(ops.activity).toEqual({ scheduled: 1, inProgress: 0, completed: 1, issues: 0, technicians: 2 });
    expect(ops.finance).toEqual({ cashHeld: 3000, cashHeldCount: 1, receivedThisMonth: 0 });
    expect(ops.approvals).toEqual(
      expect.arrayContaining([
        { key: "leaves", count: 1, href: "/leaves" },
        { key: "expenses", count: 1, href: "/expenses" },
      ]),
    );
  });

  it("shows each panel only to the people allowed to open its page", async () => {
    const forTech = await operationsOverview(asCurrent(tech), NOW);
    expect(forTech).toEqual({ attendance: null, activity: null, warehouse: null, sales: null, finance: null, approvals: null });

    const forAccountant = await operationsOverview(asCurrent(accountant), NOW);
    // Accountants: finance, sales, attendance and the warehouse; of the approvals only expenses.
    expect(forAccountant.finance).not.toBeNull();
    expect(forAccountant.sales).not.toBeNull();
    expect(forAccountant.attendance).not.toBeNull();
    expect(forAccountant.warehouse).not.toBeNull();
    expect(forAccountant.approvals?.map((i) => i.key)).toEqual(["expenses"]);

    const forSales = await operationsOverview(asCurrent(sales), NOW);
    expect(forSales.finance).toBeNull();
    expect(forSales.approvals).toBeNull();
  });
});
