import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { User } from "@prisma/client";
import { createAppointment, getAppointment, getAppointmentHistory, recordVisitOutcome } from "@/server/services/appointments";
import { listAttachments, readAttachment, removeAttachment, setDeliveryChecklist, uploadAttachment } from "@/server/services/attachments";
import { DEFAULT_SETTINGS, updateSettings } from "@/server/services/settings";
import { saveModel, stockIn, moveStock } from "@/server/services/stock";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { appointmentPayload, asCurrent, makeUser, prisma, resetDb, seedStatuses } from "../helpers";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 5, 6, 7, 8]);
const TEXT = new TextEncoder().encode("<svg onload=alert(1)>");

let dir: string;
let admin: User, sales: User, otherSales: User, tech: User, otherTech: User, viewer: User, accountant: User, store: User;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "ims-uploads-"));
  process.env.UPLOAD_DIR = dir;
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await resetDb();
  await seedStatuses();
  admin = await makeUser("ADMIN");
  sales = await makeUser("SALES");
  otherSales = await makeUser("SALES");
  tech = await makeUser("TECHNICIAN");
  otherTech = await makeUser("TECHNICIAN");
  viewer = await makeUser("VIEWER", { viewerPermissions: ["appointments.view"] });
  accountant = await makeUser("ACCOUNTANT");
  store = await makeUser("STORE");
});

async function book(overrides: Record<string, unknown> = {}) {
  return createAppointment(asCurrent(sales), appointmentPayload({ technicianIds: [tech.id], visitType: "INSTALLATION", ...overrides }));
}

async function storedFiles(): Promise<number> {
  const walk = async (d: string): Promise<number> => {
    let n = 0;
    for (const e of await readdir(d, { withFileTypes: true })) n += e.isDirectory() ? await walk(path.join(d, e.name)) : 1;
    return n;
  };
  return walk(dir).catch((e: NodeJS.ErrnoException) => (e.code === "ENOENT" ? 0 : Promise.reject(e)));
}

describe("photos and signatures", () => {
  it("lets Sales add before photos and the assigned technician add after photos and the signature", async () => {
    const a = await book();
    const before = await uploadAttachment(asCurrent(sales), a.id, "BEFORE_PHOTO", JPEG);
    const after = await uploadAttachment(asCurrent(tech), a.id, "AFTER_PHOTO", PNG);
    await uploadAttachment(asCurrent(tech), a.id, "SIGNATURE", PNG);

    // The technician does not add Sales' photos, and other people's visits are invisible.
    await expect(uploadAttachment(asCurrent(tech), a.id, "BEFORE_PHOTO", JPEG)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(uploadAttachment(asCurrent(otherTech), a.id, "AFTER_PHOTO", JPEG)).rejects.toBeInstanceOf(NotFoundError);
    await expect(uploadAttachment(asCurrent(viewer), a.id, "AFTER_PHOTO", JPEG)).rejects.toBeInstanceOf(ForbiddenError);
    // Another Sales employee only when Sales may edit each other's bookings.
    await expect(uploadAttachment(asCurrent(otherSales, { salesCanEditOthersAppointments: false }), a.id, "BEFORE_PHOTO", JPEG)).rejects.toBeInstanceOf(ForbiddenError);

    const forViewer = await listAttachments(asCurrent(viewer), a.id);
    expect(forViewer.items.map((i) => i.kind)).toEqual(["BEFORE_PHOTO", "AFTER_PHOTO", "SIGNATURE"]);
    expect(forViewer.rights).toMatchObject({ BEFORE_PHOTO: false, AFTER_PHOTO: false, SIGNATURE: false });
    expect(forViewer.items.every((i) => !i.canDelete)).toBe(true);
    expect((await listAttachments(asCurrent(tech), a.id)).rights).toEqual({ BEFORE_PHOTO: false, AFTER_PHOTO: true, SIGNATURE: true, PAYMENT_PROOF: true, DEPOSIT_PROOF: false });

    const file = await readAttachment(asCurrent(viewer), before.id);
    expect(file.contentType).toBe("image/jpeg");
    expect(new Uint8Array(file.bytes)).toEqual(JPEG);
    await expect(readAttachment(asCurrent(otherTech), after.id)).rejects.toBeInstanceOf(NotFoundError);

    const history = await getAppointmentHistory(asCurrent(sales), a.id);
    expect(history.filter((h) => h.action === "ATTACHMENT_ADDED")).toHaveLength(3);
    expect(await storedFiles()).toBe(3);
  });

  it("checks the real file type, not the name or declared type", async () => {
    const a = await book();
    await expect(uploadAttachment(asCurrent(tech), a.id, "AFTER_PHOTO", TEXT)).rejects.toBeInstanceOf(ValidationError);
    await expect(uploadAttachment(asCurrent(tech), a.id, "SIGNATURE", JPEG)).rejects.toBeInstanceOf(ValidationError);
    await expect(uploadAttachment(asCurrent(tech), a.id, "OTHER", PNG)).rejects.toBeInstanceOf(ValidationError);
    await expect(uploadAttachment(asCurrent(tech), a.id, "AFTER_PHOTO", null)).rejects.toBeInstanceOf(ValidationError);
    expect(await prisma.attachment.count()).toBe(0);
    expect(await storedFiles()).toBe(0);
  });

  it("keeps one current signature, limits photos to 20 and never deletes a row", async () => {
    const a = await book();
    const first = await uploadAttachment(asCurrent(tech), a.id, "SIGNATURE", PNG);
    const second = await uploadAttachment(asCurrent(tech), a.id, "SIGNATURE", PNG);
    const current = (await listAttachments(asCurrent(tech), a.id)).items;
    expect(current.map((i) => i.id)).toEqual([second.id]);
    expect((await prisma.attachment.findUniqueOrThrow({ where: { id: first.id } })).deletedById).toBe(tech.id);
    await expect(readAttachment(asCurrent(tech), first.id)).rejects.toBeInstanceOf(NotFoundError);

    for (let i = 0; i < 20; i++) await uploadAttachment(asCurrent(tech), a.id, "AFTER_PHOTO", JPEG);
    await expect(uploadAttachment(asCurrent(tech), a.id, "AFTER_PHOTO", JPEG)).rejects.toBeInstanceOf(ValidationError);

    await expect(prisma.$executeRaw`DELETE FROM attachments WHERE id = ${second.id}`).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRaw`UPDATE attachments SET "storageKey" = 'x' WHERE id = ${second.id}`).rejects.toThrow(/append-only/);
  });

  it("lets the uploader or the booking's manager remove a file, keeping it for the record", async () => {
    const a = await book({ technicianIds: [tech.id, otherTech.id] });
    const photo = await uploadAttachment(asCurrent(tech), a.id, "AFTER_PHOTO", JPEG);
    await expect(removeAttachment(asCurrent(otherTech), photo.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await listAttachments(asCurrent(otherTech), a.id)).items[0]!.canDelete).toBe(false);
    await removeAttachment(asCurrent(sales), photo.id);
    await expect(removeAttachment(asCurrent(tech), photo.id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await listAttachments(asCurrent(tech), a.id)).items).toHaveLength(0);
    const row = await prisma.attachment.findUniqueOrThrow({ where: { id: photo.id } });
    expect(row.deletedById).toBe(sales.id);
    expect(await storedFiles()).toBe(1);
    expect((await getAppointmentHistory(asCurrent(admin), a.id))[0]!.action).toBe("ATTACHMENT_REMOVED");
  });
});

describe("payment proofs", () => {
  it("shows transfer and deposit proofs only to people who see money and the visit's technicians", async () => {
    const a = await book({ totalPrice: 4500, depositAmount: 1500, depositMethod: "INSTAPAY" });
    const deposit = await uploadAttachment(asCurrent(sales), a.id, "DEPOSIT_PROOF", JPEG);
    const transfer = await uploadAttachment(asCurrent(tech), a.id, "PAYMENT_PROOF", JPEG);
    await expect(uploadAttachment(asCurrent(tech), a.id, "DEPOSIT_PROOF", JPEG)).rejects.toBeInstanceOf(ForbiddenError);

    expect((await listAttachments(asCurrent(viewer), a.id)).items).toHaveLength(0);
    await expect(readAttachment(asCurrent(viewer), transfer.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(removeAttachment(asCurrent(viewer), deposit.id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await listAttachments(asCurrent(accountant), a.id)).items.map((i) => i.kind)).toEqual(["DEPOSIT_PROOF", "PAYMENT_PROOF"]);
    expect((await listAttachments(asCurrent(tech), a.id)).items.map((i) => i.kind)).toEqual(["DEPOSIT_PROOF", "PAYMENT_PROOF"]);
  });
});

describe("delivery checklist and rules", () => {
  it("saves only the checklist items of the product, by the assigned technician", async () => {
    const a = await book();
    expect(await setDeliveryChecklist(asCurrent(tech), a.id, { items: ["lock.app", "lock.access"] })).toEqual(["lock.access", "lock.app"]);
    await expect(setDeliveryChecklist(asCurrent(tech), a.id, { items: ["smart.paired"] })).rejects.toBeInstanceOf(ValidationError);
    await expect(setDeliveryChecklist(asCurrent(tech), a.id, { items: "lock.app" })).rejects.toBeInstanceOf(ValidationError);
    await expect(setDeliveryChecklist(asCurrent(otherTech), a.id, { items: [] })).rejects.toBeInstanceOf(NotFoundError);
    await expect(setDeliveryChecklist(asCurrent(viewer), a.id, { items: [] })).rejects.toBeInstanceOf(ForbiddenError);
    const fresh = await getAppointment(asCurrent(sales), a.id);
    expect(fresh.deliveryChecklist).toEqual(["lock.access", "lock.app"]);
    // Ticking is not a booking edit: an open edit form keeps its version.
    expect(fresh.version).toBe(a.version);
    expect((await getAppointmentHistory(asCurrent(sales), a.id))[0]).toMatchObject({ action: "DELIVERY_CHECKLIST" });
  });

  it("changes nothing while the rules are off (the default)", async () => {
    const a = await book();
    const done = await recordVisitOutcome(asCurrent(tech), a.id, { outcome: "COMPLETED", report: "Installed", version: a.version });
    expect(done.status.kind).toBe("COMPLETED");
  });

  it("refuses Done until the checklist, an after photo, the signature and the transfer proof are in", async () => {
    await updateSettings(asCurrent(admin), { ...DEFAULT_SETTINGS, requireDeliveryProof: true });
    const a = await book({ totalPrice: 3000 });
    const attempt = recordVisitOutcome(asCurrent(tech), a.id, { outcome: "COMPLETED", report: "Installed", version: a.version });
    await expect(attempt).rejects.toBeInstanceOf(ValidationError);
    const err = (await attempt.catch((e) => e)) as ValidationError;
    expect(err.message).toBe("The visit cannot be marked done yet.");
    expect(err.fieldErrors.outcome!.split("\n")).toEqual(["Delivery checklist (4 items left)", "A photo after the installation", "The customer's signature"]);

    await setDeliveryChecklist(asCurrent(tech), a.id, { items: ["lock.access", "lock.app", "lock.handover", "lock.door"] });
    await uploadAttachment(asCurrent(tech), a.id, "AFTER_PHOTO", JPEG);
    await uploadAttachment(asCurrent(tech), a.id, "SIGNATURE", PNG);
    // Paid by InstaPay at the visit: the transfer proof is needed too.
    await expect(
      recordVisitOutcome(asCurrent(tech), a.id, { outcome: "COMPLETED", report: "Installed", collectedAmount: "3000", collectedMethod: "INSTAPAY", version: a.version }),
    ).rejects.toThrow(ValidationError);
    expect(await prisma.appointment.findUniqueOrThrow({ where: { id: a.id }, select: { collectedAmount: true } })).toEqual({ collectedAmount: null });
    await uploadAttachment(asCurrent(tech), a.id, "PAYMENT_PROOF", JPEG);
    const done = await recordVisitOutcome(asCurrent(tech), a.id, { outcome: "COMPLETED", report: "Installed", collectedAmount: "3000", collectedMethod: "INSTAPAY", version: a.version });
    expect(done.status.kind).toBe("COMPLETED");
  });

  it("asks a non-installation visit only for the signature, and never blocks managers", async () => {
    await updateSettings(asCurrent(admin), { ...DEFAULT_SETTINGS, requireDeliveryProof: true });
    const maintenance = await book({ visitType: "MAINTENANCE" });
    const err = (await recordVisitOutcome(asCurrent(tech), maintenance.id, { outcome: "COMPLETED", report: "Battery changed", version: maintenance.version }).catch((e) => e)) as ValidationError;
    expect(err.fieldErrors.outcome).toBe("The customer's signature");
    // Cash needs no proof.
    await uploadAttachment(asCurrent(tech), maintenance.id, "SIGNATURE", PNG);
    expect((await recordVisitOutcome(asCurrent(tech), maintenance.id, { outcome: "COMPLETED", report: "Battery changed", version: maintenance.version })).status.kind).toBe("COMPLETED");

    const other = await book({ date: "2030-03-11" });
    expect((await recordVisitOutcome(asCurrent(sales), other.id, { outcome: "COMPLETED", report: "Recorded from the office", version: other.version })).status.kind).toBe("COMPLETED");
    // "Needs another visit" is never blocked.
    const third = await book({ date: "2030-03-12" });
    expect((await recordVisitOutcome(asCurrent(tech), third.id, { outcome: "NEEDS_REVISIT", report: "Door not ready", version: third.version })).status.kind).toBe("NEEDS_REVISIT");
  });

  it("requires an installed serial when the Admin turns it on", async () => {
    await updateSettings(asCurrent(admin), { ...DEFAULT_SETTINGS, serialRequired: true });
    const model = await saveModel(asCurrent(store), null, { name: "Philips 9300", category: "SMART_LOCK", warrantyMonths: 24 });
    await stockIn(asCurrent(store), { modelId: model.id, serials: "SN-1" });
    const item = await prisma.stockItem.findFirstOrThrow({ where: { serial: "SN-1" } });
    await moveStock(asCurrent(store), { itemIds: [item.id], to: "WITH_TECHNICIAN", technicianId: tech.id });
    const a = await book();
    const err = (await recordVisitOutcome(asCurrent(tech), a.id, { outcome: "COMPLETED", report: "Installed", version: a.version }).catch((e) => e)) as ValidationError;
    expect(err.fieldErrors.outcome).toBe("The serial number of the installed item");
    const done = await recordVisitOutcome(asCurrent(tech), a.id, { outcome: "COMPLETED", report: "Installed", serials: "SN-1", version: a.version });
    expect(done.status.kind).toBe("COMPLETED");
  });
});
