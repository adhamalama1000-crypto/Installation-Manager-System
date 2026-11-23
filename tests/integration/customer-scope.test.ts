/**
 * A booking may only update an existing customer the caller is allowed to see (audit M2): a
 * customer id from the client is never trusted on its own. Rejected requests change nothing and
 * create nothing.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { User } from "@prisma/client";
import { createAppointment, updateAppointment } from "@/server/services/appointments";
import { ValidationError } from "@/server/errors";
import { appointmentPayload, asCurrent, makeUser, prisma, resetDb, seedStatuses } from "../helpers";

let salesA: User, salesB: User;
let victimId: string, victimBookingId: string;

const withCustomer = (id: string, name: string, extra: Record<string, unknown> = {}) =>
  appointmentPayload({ customer: { id, name, phone: "+20 111 222 3333", secondaryPhone: "" }, ...extra });

async function withScopes(u: User, scopes: Record<string, string>) {
  return prisma.user.update({ where: { id: u.id }, data: { dataScopes: scopes } });
}

async function expectRejected(p: Promise<unknown>) {
  const e = await p.catch((x: unknown) => x);
  expect(e).toBeInstanceOf(ValidationError);
  expect((e as ValidationError).fieldErrors["customer.id"]).toBeTruthy();
}

async function victimUnchanged() {
  const c = await prisma.customer.findUniqueOrThrow({ where: { id: victimId } });
  expect({ name: c.name, phone: c.phone }).toEqual({ name: "Victim Customer", phone: "+20 100 999 8888" });
}

beforeEach(async () => {
  await resetDb();
  await seedStatuses();
  salesA = await makeUser("SALES", { name: "Sales A" });
  salesB = await makeUser("SALES", { name: "Sales B" });
  const b = await createAppointment(asCurrent(salesB), appointmentPayload({ customer: { name: "Victim Customer", phone: "+20 100 999 8888", secondaryPhone: "" } }));
  victimId = b.customer.id;
  victimBookingId = b.id;
  // Sales A may only see their own customers.
  salesA = await withScopes(salesA, { customers: "OWN" });
});

describe("customer references in bookings", () => {
  it("refuses to update someone else's customer through a new booking, changing and creating nothing", async () => {
    const before = { customers: await prisma.customer.count(), appointments: await prisma.appointment.count(), locations: await prisma.customerLocation.count() };
    await expectRejected(createAppointment(asCurrent(salesA), withCustomer(victimId, "Hijacked Name")));
    await victimUnchanged();
    expect({ customers: await prisma.customer.count(), appointments: await prisma.appointment.count(), locations: await prisma.customerLocation.count() }).toEqual(before);
  });

  it("refuses to switch an existing booking to someone else's customer", async () => {
    const mine = await createAppointment(asCurrent(salesA), appointmentPayload({ date: "2030-03-11" }));
    await expectRejected(updateAppointment(asCurrent(salesA), mine.id, { ...withCustomer(victimId, "Hijacked Name", { date: "2030-03-11" }), version: mine.version }));
    await victimUnchanged();
    const after = await prisma.appointment.findUniqueOrThrow({ where: { id: mine.id } });
    expect(after.customerId).toBe(mine.customer.id);
    expect(after.version).toBe(mine.version);
  });

  it("answers an unknown or malformed id exactly like an out-of-scope one, and creates no customer", async () => {
    const customers = await prisma.customer.count();
    await expectRejected(createAppointment(asCurrent(salesA), withCustomer("does-not-exist", "X")));
    await expectRejected(createAppointment(asCurrent(salesA), withCustomer("x".repeat(65), "X")));
    const unknown = (await createAppointment(asCurrent(salesA), withCustomer("does-not-exist", "X")).catch((e: ValidationError) => e)) as ValidationError;
    const outside = (await createAppointment(asCurrent(salesA), withCustomer(victimId, "X")).catch((e: ValidationError) => e)) as ValidationError;
    expect(unknown.fieldErrors).toEqual(outside.fieldErrors);
    expect(await prisma.customer.count()).toBe(customers);
  });

  it("still lets an authorised caller update an existing customer", async () => {
    // Sales B owns the customer; Sales A with the default (ALL) customer scope may use it too.
    const own = await createAppointment(asCurrent(salesB), withCustomer(victimId, "Victim Customer (renamed)", { date: "2030-03-12" }));
    expect(own.customer.id).toBe(victimId);
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: victimId } })).name).toBe("Victim Customer (renamed)");
    const allA = await withScopes(salesA, {});
    const other = await createAppointment(asCurrent(allA), withCustomer(victimId, "Renamed by A", { date: "2030-03-13" }));
    expect(other.customer.id).toBe(victimId);
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: victimId } })).name).toBe("Renamed by A");
  });

  it("lets a booking's editor keep (and correct) the booking's own customer even outside their customer scope", async () => {
    // Sales may edit each other's bookings (setting); the booking's customer is not in A's customer scope.
    const settings = { salesCanEditOthersAppointments: true };
    const victimBooking = await prisma.appointment.findUniqueOrThrow({ where: { id: victimBookingId } });
    const updated = await updateAppointment(asCurrent(salesA, settings), victimBookingId, { ...withCustomer(victimId, "Victim Customer", { date: "2030-03-10" }), version: victimBooking.version });
    expect(updated.customer.id).toBe(victimId);
  });

  it("refuses a follow-up for a customer outside the caller's customer scope, even with unchanged details (review R3)", async () => {
    const original = await prisma.appointment.findUniqueOrThrow({ where: { id: victimBookingId } });
    const before = { appointments: await prisma.appointment.count(), locations: await prisma.customerLocation.count() };
    const prefilled = { id: victimId, name: "Victim Customer", phone: "+20 100 999 8888", secondaryPhone: "" };
    const site = { ...appointmentPayload().location, id: original.locationId };
    const attempts = [
      { customer: { ...prefilled, name: "Renamed via follow-up" }, location: site }, // the review's attack
      { customer: { ...prefilled, phone: "+20 155 000 0000" }, location: site },
      { customer: prefilled, location: { ...site, streetAddress: "1 Attacker Street" } },
      // Unchanged too: linking would make the customer "own" (they booked a visit) and open them to edits.
      { customer: prefilled, location: site },
    ];
    for (const { customer, location } of attempts) {
      const e = (await createAppointment(asCurrent(salesA), { ...appointmentPayload({ date: "2030-03-25", customer, location }), followUpOfId: victimBookingId }).catch((x: unknown) => x)) as ValidationError;
      expect(e).toBeInstanceOf(ValidationError);
      expect(e.fieldErrors["customer.id"]).toMatch(/outside the customers you handle/);
    }
    await victimUnchanged();
    expect({ appointments: await prisma.appointment.count(), locations: await prisma.customerLocation.count() }).toEqual(before);
    // So the two-step chain (link via follow-up, then edit as an "own" customer) cannot start.
    await expectRejected(createAppointment(asCurrent(salesA), withCustomer(victimId, "Second step", { date: "2030-03-27" })));
    await victimUnchanged();
  });

  it("still books follow-ups for in-scope callers (and lets them correct the customer)", async () => {
    const allA = await withScopes(salesA, {});
    const f = await createAppointment(asCurrent(allA), { ...withCustomer(victimId, "Victim Customer (corrected)", { date: "2030-03-26" }), followUpOfId: victimBookingId });
    expect(f.customer.id).toBe(victimId);
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: victimId } })).name).toBe("Victim Customer (corrected)");
    // The visit's own salesperson, of course, too.
    const own = await createAppointment(asCurrent(salesB), { ...withCustomer(victimId, "Victim Customer", { date: "2030-03-28" }), followUpOfId: victimBookingId });
    expect(own.customer.id).toBe(victimId);
  });

  it("lets an out-of-scope caller book a follow-up for a new customer record (nothing existing is touched)", async () => {
    const f = await createAppointment(asCurrent(salesA), { ...appointmentPayload({ date: "2030-03-29", customer: { name: "New Person", phone: "+20 109 000 1234", secondaryPhone: "" } }), followUpOfId: victimBookingId });
    expect(f.customer.id).not.toBe(victimId);
    await victimUnchanged();
  });

  it("does not let concurrent requests slip an out-of-scope update through", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => createAppointment(asCurrent(salesA), withCustomer(victimId, `Hijack ${i}`, { date: `2030-04-${String(i + 1).padStart(2, "0")}` }))),
    );
    expect(results.every((r) => r.status === "rejected" && r.reason instanceof ValidationError)).toBe(true);
    await victimUnchanged();
  });
});
