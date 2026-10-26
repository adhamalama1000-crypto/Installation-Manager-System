import { beforeEach, describe, expect, it } from "vitest";
import { createAppointment } from "@/server/services/appointments";
import { salesPeople } from "@/server/services/users";
import { appointmentPayload, asCurrent, makeUser, prisma, resetDb, seedStatuses } from "../helpers";

beforeEach(async () => {
  await resetDb();
  await seedStatuses();
});

describe("sales people (colour legend and creator filter)", () => {
  it("lists Sales and Admins, plus anyone else who created bookings, by name", async () => {
    const zed = await makeUser("SALES", { name: "Zed Sales" });
    const amy = await makeUser("ADMIN", { name: "Amy Admin" });
    const former = await makeUser("SALES", { name: "Mona Former" });
    await makeUser("TECHNICIAN", { name: "Bob Tech" });
    await makeUser("VIEWER", { name: "Carl Viewer" });
    const gone = await makeUser("SALES", { name: "Dina Gone" });
    await createAppointment(asCurrent(former), appointmentPayload());
    // The creator later moved to another role and the other left: their bookings keep their colour.
    await prisma.user.update({ where: { id: former.id }, data: { role: "VIEWER" } });
    await prisma.user.update({ where: { id: gone.id }, data: { isActive: false } });

    expect((await salesPeople()).map((u) => u.name)).toEqual(["Amy Admin", "Mona Former", "Zed Sales"]);
    const all = await salesPeople({ includeInactive: true });
    expect(all.map((u) => u.name)).toEqual(["Amy Admin", "Dina Gone", "Mona Former", "Zed Sales"]);
    expect(all.find((u) => u.id === former.id)).toMatchObject({ role: "VIEWER", isActive: true, color: "#2563EB" });
    expect(all.find((u) => u.id === amy.id)?.role).toBe("ADMIN");
    expect(all.some((u) => u.id === zed.id)).toBe(true);
  });
});
