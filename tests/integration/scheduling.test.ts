import { beforeEach, describe, expect, it } from "vitest";
import type { User } from "@prisma/client";
import {
  cancelAppointment,
  changeAppointmentStatus,
  createAppointment,
  getAppointment,
  updateAppointment,
} from "@/server/services/appointments";
import { SchedulingConflictError, ValidationError } from "@/server/errors";
import { appointmentPayload, asCurrent, makeUser, prisma, resetDb, seedStatuses } from "../helpers";

let statuses: Awaited<ReturnType<typeof seedStatuses>>;
let admin: User;
let sales: User;
let sales2: User;
let techA: User;
let techB: User;
let techC: User;

beforeEach(async () => {
  await resetDb();
  statuses = await seedStatuses();
  admin = await makeUser("ADMIN");
  sales = await makeUser("SALES", { color: "#E55823" });
  sales2 = await makeUser("SALES", { color: "#2563EB" });
  techA = await makeUser("TECHNICIAN", { name: "Tech A" });
  techB = await makeUser("TECHNICIAN", { name: "Tech B" });
  techC = await makeUser("TECHNICIAN", { name: "Tech C" });
});

async function expectConflict(p: Promise<unknown>): Promise<SchedulingConflictError> {
  const err = await p.then(
    () => null,
    (e) => e,
  );
  expect(err).toBeInstanceOf(SchedulingConflictError);
  return err as SchedulingConflictError;
}

describe("appointment creation", () => {
  it("creates an appointment with multiple technicians and keeps apartment/floor separate", async () => {
    const appt = await createAppointment(asCurrent(sales), appointmentPayload({ technicianIds: [techA.id, techB.id] }));
    expect(appt.code).toMatch(/^APT-\d{6}$/);
    expect(appt.technicians.map((t) => t.name).sort()).toEqual(["Tech A", "Tech B"]);
    expect(appt.createdBy.id).toBe(sales.id);
    expect(appt.location?.apartment).toBe("14B");
    expect(appt.location?.floor).toBe("3");
    expect(appt.location?.mapUrl).toBe("https://maps.app.goo.gl/abc123");
    expect(appt.location?.link).toBe("https://maps.app.goo.gl/abc123");
    expect(appt.status.name).toBe("Scheduled");
    // 10:00 Cairo (UTC+2 in March) is 08:00 UTC; the time is stored as an exact instant.
    expect(appt.startsAt).toBe("2030-03-10T08:00:00.000Z");
    expect(appt.endsAt).toBe("2030-03-10T10:00:00.000Z");
    const row = await prisma.customerLocation.findFirstOrThrow();
    expect(row.apartment).toBe("14B");
    expect(row.floor).toBe("3");
  });

  it("validates required fields and map links", async () => {
    const bad = appointmentPayload({
      customer: { name: "", phone: "12" },
      location: { ...appointmentPayload().location, mapUrl: "javascript:alert(1)" },
      date: "2030-02-31",
    });
    const err = await createAppointment(asCurrent(sales), bad).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    const fields = (err as ValidationError).fieldErrors;
    expect(fields["customer.name"]).toBeDefined();
    expect(fields["customer.phone"]).toBeDefined();
    expect(fields["location.mapUrl"]).toBeDefined();
    expect(fields.date).toBeDefined();
  });

  it("builds an Open Location link from coordinates when no URL is given", async () => {
    const appt = await createAppointment(
      asCurrent(sales),
      appointmentPayload({ location: { ...appointmentPayload().location, mapUrl: "", latitude: "30.0444", longitude: "31.2357" } }),
    );
    expect(appt.location?.link).toBe("https://www.google.com/maps/search/?api=1&query=30.0444,31.2357");
  });

  it("is idempotent for duplicate submissions with the same clientRequestId", async () => {
    const payload = appointmentPayload({ clientRequestId: "6f1c1b5e-4a9f-4d7b-9a51-0d6f3c1b2a11", technicianIds: [techA.id] });
    const [a, b] = await Promise.all([createAppointment(asCurrent(sales), payload), createAppointment(asCurrent(sales), payload)]);
    expect(a.id).toBe(b.id);
    expect(await prisma.appointment.count()).toBe(1);
  });

  it("does not allow assigning inactive technicians or non-technicians", async () => {
    const inactive = await makeUser("TECHNICIAN", { isActive: false });
    await expect(createAppointment(asCurrent(sales), appointmentPayload({ technicianIds: [inactive.id] }))).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(createAppointment(asCurrent(sales), appointmentPayload({ technicianIds: [sales2.id] }))).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});

describe("technician conflict prevention", () => {
  it("rejects overlapping bookings for the same technician and names the conflict", async () => {
    const first = await createAppointment(asCurrent(sales), appointmentPayload({ technicianIds: [techA.id] }));
    // 11:00-12:00 overlaps 10:00-12:00 partially (start times differ).
    const err = await expectConflict(
      createAppointment(asCurrent(sales2), appointmentPayload({ startTime: "11:00", durationMinutes: 60, technicianIds: [techA.id] })),
    );
    expect(err.conflicts).toHaveLength(1);
    expect(err.conflicts[0]!.technicianName).toBe("Tech A");
    expect(err.conflicts[0]!.appointmentCode).toBe(first.code);
    expect(err.conflicts[0]!.startsAt).toBe(first.startsAt);
  });

  it("detects a booking that fully contains an existing one", async () => {
    await createAppointment(asCurrent(sales), appointmentPayload({ startTime: "10:00", durationMinutes: 30, technicianIds: [techA.id] }));
    await expectConflict(
      createAppointment(asCurrent(sales), appointmentPayload({ startTime: "09:00", durationMinutes: 240, technicianIds: [techA.id] })),
    );
  });

  it("allows back-to-back appointments and different technicians at the same time", async () => {
    await createAppointment(asCurrent(sales), appointmentPayload({ technicianIds: [techA.id] }));
    await createAppointment(asCurrent(sales), appointmentPayload({ startTime: "12:00", technicianIds: [techA.id] }));
    await createAppointment(asCurrent(sales), appointmentPayload({ technicianIds: [techB.id, techC.id] }));
    expect(await prisma.appointment.count()).toBe(3);
  });

  it("checks every selected technician individually", async () => {
    await createAppointment(asCurrent(sales), appointmentPayload({ technicianIds: [techB.id] }));
    const err = await expectConflict(createAppointment(asCurrent(sales), appointmentPayload({ technicianIds: [techA.id, techB.id, techC.id] })));
    expect(err.conflicts.map((c) => c.technicianName)).toEqual(["Tech B"]);
    expect(await prisma.appointment.count()).toBe(1);
  });

  it("prevents simultaneous conflicting bookings (concurrency)", async () => {
    const attempts = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        createAppointment(
          asCurrent(i % 2 ? sales : sales2),
          appointmentPayload({ startTime: `10:${String(i * 5).padStart(2, "0")}`, technicianIds: [techA.id] }),
        ),
      ),
    );
    const ok = attempts.filter((a) => a.status === "fulfilled");
    const failed = attempts.filter((a) => a.status === "rejected") as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(5);
    for (const f of failed) expect(f.reason).toBeInstanceOf(SchedulingConflictError);
    expect(await prisma.appointmentTechnician.count({ where: { technicianId: techA.id } })).toBe(1);
  });

  it("is enforced by the database even if the service check is bypassed", async () => {
    const a = await createAppointment(asCurrent(sales), appointmentPayload({ technicianIds: [techA.id] }));
    const b = await createAppointment(asCurrent(sales), appointmentPayload({ startTime: "15:00", technicianIds: [techB.id] }));
    await expect(
      prisma.appointmentTechnician.create({
        data: {
          appointmentId: b.id,
          technicianId: techA.id,
          startsAt: new Date(a.startsAt),
          endsAt: new Date(a.endsAt),
          blocksSchedule: true,
        },
      }),
    ).rejects.toThrow(/appointment_technicians_no_overlap/);
  });

  it("revalidates on reschedule and excludes the appointment being edited", async () => {
    const a = await createAppointment(asCurrent(sales), appointmentPayload({ technicianIds: [techA.id] }));
    const b = await createAppointment(asCurrent(sales), appointmentPayload({ startTime: "14:00", technicianIds: [techA.id] }));
    // Moving A by 30 minutes overlaps only with itself - allowed.
    const moved = await updateAppointment(asCurrent(sales), a.id, appointmentPayload({ startTime: "10:30", technicianIds: [techA.id], version: a.version }));
    expect(moved.startsAt).toBe("2030-03-10T08:30:00.000Z");
    // Moving A onto B's slot conflicts.
    const err = await expectConflict(
      updateAppointment(asCurrent(sales), a.id, appointmentPayload({ startTime: "13:00", technicianIds: [techA.id] })),
    );
    expect(err.conflicts[0]!.appointmentId).toBe(b.id);
    // Adding a busy technician during edit is rejected too.
    await createAppointment(asCurrent(sales), appointmentPayload({ startTime: "10:00", technicianIds: [techB.id] }));
    await expectConflict(updateAppointment(asCurrent(sales), a.id, appointmentPayload({ startTime: "10:30", technicianIds: [techA.id, techB.id] })));
  });

  it("frees the technician when an appointment is cancelled and re-checks on reactivation", async () => {
    const a = await createAppointment(asCurrent(sales), appointmentPayload({ technicianIds: [techA.id] }));
    await expectConflict(createAppointment(asCurrent(sales), appointmentPayload({ technicianIds: [techA.id] })));

    const cancelled = await cancelAppointment(asCurrent(sales), a.id, { reason: "Customer travelling" });
    expect(cancelled.status.kind).toBe("CANCELLED");
    const b = await createAppointment(asCurrent(sales), appointmentPayload({ technicianIds: [techA.id] }));
    expect(b.technicians[0]!.id).toBe(techA.id);

    // Re-activating A would double-book Tech A.
    await expectConflict(changeAppointmentStatus(asCurrent(sales), a.id, { statusId: statuses.SCHEDULED }));
  });

  it("applies a configurable travel buffer", async () => {
    await prisma.setting.create({
      data: { key: "general", value: { timezone: "Africa/Cairo", travelBufferMinutes: 30 } },
    });
    await createAppointment(asCurrent(sales), appointmentPayload({ technicianIds: [techA.id] })); // 10:00-12:00
    await expectConflict(createAppointment(asCurrent(sales), appointmentPayload({ startTime: "12:15", technicianIds: [techA.id] })));
    await createAppointment(asCurrent(sales), appointmentPayload({ startTime: "12:30", technicianIds: [techA.id] }));
  });
});

describe("original Sales creator", () => {
  it("never changes when another user edits or technicians are reassigned", async () => {
    const a = await createAppointment(asCurrent(sales), appointmentPayload({ technicianIds: [techA.id] }));
    const edited = await updateAppointment(
      asCurrent(sales2),
      a.id,
      appointmentPayload({ technicianIds: [techB.id], brand: "Samsung", salesUserId: sales2.id }),
    );
    expect(edited.createdBy.id).toBe(sales.id);
    expect(edited.createdBy.color).toBe("#E55823");
    expect(edited.updatedBy?.id).toBe(sales2.id);
    const byAdmin = await updateAppointment(asCurrent(admin), a.id, appointmentPayload({ technicianIds: [techC.id] }));
    expect(byAdmin.createdBy.id).toBe(sales.id);
  });

  it("only lets an Admin book on behalf of a Sales employee", async () => {
    const a = await createAppointment(asCurrent(admin), appointmentPayload({ salesUserId: sales2.id }));
    expect(a.createdBy.id).toBe(sales2.id);
    await expect(createAppointment(asCurrent(sales), appointmentPayload({ salesUserId: sales2.id }))).rejects.toThrow(/Admin/);
  });

  it("keeps historical references to deactivated technicians", async () => {
    const a = await createAppointment(asCurrent(sales), appointmentPayload({ technicianIds: [techA.id] }));
    await prisma.user.update({ where: { id: techA.id }, data: { isActive: false } });
    // Editing other fields keeps the inactive technician on the job...
    const edited = await updateAppointment(asCurrent(sales), a.id, appointmentPayload({ technicianIds: [techA.id], brand: "Other" }));
    expect(edited.technicians[0]).toMatchObject({ id: techA.id, isActive: false });
    // ...but they cannot be added to new appointments.
    const err = await createAppointment(asCurrent(sales), appointmentPayload({ startTime: "15:00", technicianIds: [techA.id] })).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).fieldErrors.technicianIds).toMatch(/inactive/);
  });
});

describe("optimistic locking", () => {
  it("rejects an edit based on an outdated version", async () => {
    const a = await createAppointment(asCurrent(sales), appointmentPayload());
    await updateAppointment(asCurrent(sales), a.id, appointmentPayload({ brand: "First", version: a.version }));
    await expect(updateAppointment(asCurrent(sales2), a.id, appointmentPayload({ brand: "Second", version: a.version }))).rejects.toThrow(
      /changed by someone else/,
    );
    expect((await getAppointment(asCurrent(sales), a.id)).brand).toBe("First");
  });
});
