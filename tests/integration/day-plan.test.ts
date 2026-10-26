import { beforeEach, describe, expect, it } from "vitest";
import type { User } from "@prisma/client";
import { cancelAppointment, createAppointment } from "@/server/services/appointments";
import { dayPlan } from "@/server/services/day-plan";
import { ForbiddenError } from "@/server/errors";
import { appointmentPayload, asCurrent, makeUser, prisma, resetDb, seedStatuses } from "../helpers";

let statuses: Awaited<ReturnType<typeof seedStatuses>>;
let sales: User, karim: User, youssef: User;

beforeEach(async () => {
  await resetDb();
  statuses = await seedStatuses();
  sales = await makeUser("SALES");
  karim = await makeUser("TECHNICIAN", { name: "Karim Fathy" });
  youssef = await makeUser("TECHNICIAN", { name: "Youssef Nabil" });
  await prisma.user.update({ where: { id: karim.id }, data: { phone: "0111 000 1111" } });
});

describe("day plan", () => {
  it("builds one message per technician from the day's active visits", async () => {
    const book = (o: Record<string, unknown>) => createAppointment(asCurrent(sales), appointmentPayload({ date: "2030-03-10", ...o }));
    const shared = await book({ startTime: "10:00", durationMinutes: 60, technicianIds: [karim.id, youssef.id], totalPrice: 4500, depositAmount: 1500, depositMethod: "CASH" });
    await book({ startTime: "13:00", durationMinutes: 60, technicianIds: [karim.id], customer: { name: "Second Customer", phone: "0100 222 3333" } });
    const cancelled = await book({ startTime: "15:00", durationMinutes: 60, technicianIds: [karim.id] });
    await cancelAppointment(asCurrent(sales), cancelled.id, {});
    await book({ startTime: "16:00", durationMinutes: 60, technicianIds: [youssef.id], statusId: statuses.POSTPONED });
    const nobody = await book({ startTime: "17:00", durationMinutes: 60, technicianIds: [] });
    await book({ date: "2030-03-11", startTime: "10:00", technicianIds: [karim.id] }); // another day

    const plan = await dayPlan(asCurrent(sales, { companyName: "Aura Smart Homes" }), "2030-03-10");
    expect(plan.visits).toBe(3); // cancelled, postponed and next-day visits left out
    expect(plan.unassigned.map((v) => v.id)).toEqual([nobody.id]);
    expect(plan.technicians.map((t) => [t.name, t.visits.length])).toEqual([
      ["Karim Fathy", 2],
      ["Youssef Nabil", 1],
    ]);
    const [k, y] = plan.technicians;
    expect(k!.link.startsWith("https://wa.me/201110001111?text=")).toBe(true);
    expect(y!.link.startsWith("https://wa.me/?text=")).toBe(true); // no phone saved
    expect(k!.message).toContain("Your visits for Sunday 10 March:");
    expect(k!.message).toContain("💰 To collect: 3,000 EGP");
    expect(k!.message).toContain("👷 With: Youssef Nabil");
    expect(k!.message).toContain("Second Customer");
    expect(k!.message).not.toContain(cancelled.code);
    expect(y!.visits[0]).toMatchObject({ id: shared.id, withOthers: ["Karim Fathy"] });
    expect(decodeURIComponent(k!.visits[1]!.reminderLink!)).toContain("This is Aura Smart Homes.");
  });

  it("is only for people who manage bookings", async () => {
    await expect(dayPlan(asCurrent(karim), "2030-03-10")).rejects.toBeInstanceOf(ForbiddenError);
  });
});
