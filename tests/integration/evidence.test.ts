import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { User } from "@prisma/client";
import { createAppointment, getAppointment, recordVisitOutcome } from "@/server/services/appointments";
import { listAttachments, locateAttachment, uploadAttachment } from "@/server/services/attachments";
import { decideWork, evidenceStatus, listEvidenceRules, resubmitWork, reviewQueue, saveEvidenceRule } from "@/server/services/evidence";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { detectVideoType, parseRange } from "@/server/storage";
import { appointmentPayload, asCurrent, makeUser, prisma, resetDb, seedStatuses } from "../helpers";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 5, 6, 7, 8]);
const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
/** The first bytes of an MP4 ("ftyp" box, brand isom), a QuickTime and a WebM file. */
const MP4 = new Uint8Array([0, 0, 0, 0x20, ...ascii("ftypisom"), 0, 0, 2, 0, ...ascii("isomiso2avc1mp41"), 9, 9, 9, 9]);
const MOV = new Uint8Array([0, 0, 0, 0x14, ...ascii("ftypqt  "), 0, 0, 2, 0, ...ascii("qt  "), 9, 9]);
const WEBM = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84, ...ascii("webm"), 0x42, 0x87, 0x81, 0x04]);
const MKV = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x88, ...ascii("matroska"), 0x42, 0x87]);

let dir: string;
let admin: User, sales: User, tech: User, otherTech: User;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "ims-evidence-"));
  process.env.UPLOAD_DIR = dir;
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetDb();
  await seedStatuses();
  admin = await makeUser("ADMIN");
  sales = await makeUser("SALES");
  tech = await makeUser("TECHNICIAN");
  otherTech = await makeUser("TECHNICIAN");
});

async function book(overrides: Record<string, unknown> = {}) {
  return createAppointment(asCurrent(sales), appointmentPayload({ technicianIds: [tech.id], visitType: "INSTALLATION", ...overrides }));
}

const FULL = {
  visitType: "INSTALLATION",
  productCategory: "SMART_LOCK",
  minBeforePhotos: 1,
  minAfterPhotos: 2,
  requireVideo: true,
  requireSignature: true,
  requireCustomerConfirmation: true,
  requireReview: true,
};

const done = (extra: Record<string, unknown> = {}) => ({ outcome: "COMPLETED", report: "Lock installed and tested", ...extra });

async function addAllEvidence(appointmentId: string) {
  await uploadAttachment(asCurrent(tech), appointmentId, "BEFORE_PHOTO", JPEG);
  await uploadAttachment(asCurrent(tech), appointmentId, "AFTER_PHOTO", JPEG);
  await uploadAttachment(asCurrent(tech), appointmentId, "AFTER_PHOTO", PNG);
  await uploadAttachment(asCurrent(tech), appointmentId, "VIDEO", MP4);
  await uploadAttachment(asCurrent(tech), appointmentId, "SIGNATURE", PNG);
}

describe("evidence rules", () => {
  it("are set by Admins only, one per visit type and category, with an audit entry", async () => {
    await expect(saveEvidenceRule(asCurrent(tech), FULL)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(saveEvidenceRule(asCurrent(sales), FULL)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listEvidenceRules(asCurrent(tech))).rejects.toBeInstanceOf(NotFoundError);

    const first = await saveEvidenceRule(asCurrent(admin), FULL);
    const second = await saveEvidenceRule(asCurrent(admin), { ...FULL, minAfterPhotos: 3 });
    expect(second.id).toBe(first.id);
    expect(await prisma.evidenceRule.count()).toBe(1);
    expect((await listEvidenceRules(asCurrent(admin)))[0]).toMatchObject({ visitType: "INSTALLATION", productCategory: "SMART_LOCK", minAfterPhotos: 3 });

    // '' means any visit type / any category.
    const any = await saveEvidenceRule(asCurrent(admin), { visitType: "", productCategory: "", minAfterPhotos: 1 });
    expect(any).toMatchObject({ visitType: null, productCategory: null, minAfterPhotos: 1, requireVideo: false });

    const audits = await prisma.auditLog.findMany({ where: { entityType: "EVIDENCE" }, orderBy: { createdAt: "asc" } });
    expect(audits.map((a) => a.action)).toEqual(["EVIDENCE_RULE_CREATED", "EVIDENCE_RULE_UPDATED", "EVIDENCE_RULE_CREATED"]);
    expect(audits[1].changes).toMatchObject({ before: { minAfterPhotos: 2 }, after: { minAfterPhotos: 3 } });
  });

  it("refuses counts out of range and unknown visit types", async () => {
    await expect(saveEvidenceRule(asCurrent(admin), { ...FULL, minAfterPhotos: 21 })).rejects.toMatchObject({ fieldErrors: { minAfterPhotos: expect.any(String) } });
    await expect(saveEvidenceRule(asCurrent(admin), { ...FULL, minBeforePhotos: -1 })).rejects.toBeInstanceOf(ValidationError);
    await expect(saveEvidenceRule(asCurrent(admin), { ...FULL, visitType: "PARTY" })).rejects.toMatchObject({ fieldErrors: { visitType: expect.any(String) } });
  });

  it("apply the most specific active rule to a visit", async () => {
    await saveEvidenceRule(asCurrent(admin), { visitType: "", productCategory: "", minAfterPhotos: 5 });
    await saveEvidenceRule(asCurrent(admin), { visitType: "INSTALLATION", productCategory: "", minAfterPhotos: 2 });
    await saveEvidenceRule(asCurrent(admin), { visitType: "INSTALLATION", productCategory: "SMART_LOCK", minAfterPhotos: 1, isActive: false });
    const a = await book();
    // The exact rule is inactive, so the visit-type rule applies (not the rule for every visit).
    expect((await evidenceStatus(asCurrent(tech), a.id)).rule).toMatchObject({ minAfterPhotos: 2, visitType: "INSTALLATION", productCategory: null });
    const m = await book({ visitType: "MAINTENANCE", startTime: "14:00" });
    expect((await evidenceStatus(asCurrent(tech), m.id)).rule).toMatchObject({ minAfterPhotos: 5, visitType: null });
  });
});

describe("completing a visit", () => {
  it("is refused while evidence is missing, then submits the work for review", async () => {
    await saveEvidenceRule(asCurrent(admin), FULL);
    const a = await book();

    const refused = await recordVisitOutcome(asCurrent(tech), a.id, done()).catch((e) => e);
    expect(refused).toBeInstanceOf(ValidationError);
    const lines = (refused as ValidationError).fieldErrors.outcome.split("\n");
    expect(lines).toEqual(["1 more before photo", "2 more after photos", "A video of the work", "The customer's signature", "The customer's confirmation of the work"]);
    expect((await getAppointment(asCurrent(tech), a.id)).status.kind).toBe("SCHEDULED");

    // The rule asks for before photos, so the technician may add them on site.
    expect((await listAttachments(asCurrent(tech), a.id)).rights.BEFORE_PHOTO).toBe(true);
    await addAllEvidence(a.id);
    // Everything but the customer's confirmation.
    await expect(recordVisitOutcome(asCurrent(tech), a.id, done())).rejects.toMatchObject({ fieldErrors: { outcome: "The customer's confirmation of the work" } });

    await recordVisitOutcome(asCurrent(tech), a.id, done({ customerConfirmed: true, customerName: "Mona" }));
    expect((await getAppointment(asCurrent(tech), a.id)).status.kind).toBe("COMPLETED");
    const status = await evidenceStatus(asCurrent(admin), a.id);
    expect(status).toMatchObject({ status: "SUBMITTED", missing: [], state: { beforePhotos: 1, afterPhotos: 2, videos: 1, hasSignature: true, customerConfirmed: true }, can: { review: true, resubmit: false } });
    expect(status.history).toMatchObject([{ event: "SUBMITTED", customerConfirmed: true, customerName: "Mona", actor: { id: tech.id } }]);
    expect(await prisma.notification.count({ where: { userId: admin.id, type: "EVIDENCE" } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { appointmentId: a.id, action: "WORK_SUBMITTED" } })).toBe(1);
    expect(await reviewQueue(asCurrent(admin))).toMatchObject([{ appointmentId: a.id, event: "SUBMITTED", by: tech.name }]);
  });

  it("does not hold managers to the rule, but still asks for the review", async () => {
    await saveEvidenceRule(asCurrent(admin), { ...FULL, productCategory: "" });
    const a = await book();
    await recordVisitOutcome(asCurrent(sales), a.id, done());
    expect((await getAppointment(asCurrent(sales), a.id)).status.kind).toBe("COMPLETED");
    const s = await evidenceStatus(asCurrent(admin), a.id);
    expect(s.status).toBe("SUBMITTED");
    expect(s.missing.length).toBeGreaterThan(0);
  });

  it("leaves visits without a rule as they were", async () => {
    const a = await book();
    await recordVisitOutcome(asCurrent(tech), a.id, done());
    const s = await evidenceStatus(asCurrent(tech), a.id);
    expect(s).toMatchObject({ rule: null, status: null, history: [] });
    expect(await prisma.workReview.count()).toBe(0);
    // Without a rule asking for before photos, they stay Sales' photos.
    expect((await listAttachments(asCurrent(tech), a.id)).rights.BEFORE_PHOTO).toBe(false);
  });

  it("only asks for a review when the rule does", async () => {
    await saveEvidenceRule(asCurrent(admin), { visitType: "INSTALLATION", productCategory: "", minAfterPhotos: 1 });
    const a = await book();
    await uploadAttachment(asCurrent(tech), a.id, "AFTER_PHOTO", JPEG);
    await recordVisitOutcome(asCurrent(tech), a.id, done());
    expect((await evidenceStatus(asCurrent(tech), a.id)).status).toBeNull();
  });
});

describe("the review", () => {
  async function submitted() {
    await saveEvidenceRule(asCurrent(admin), FULL);
    const a = await book();
    await addAllEvidence(a.id);
    await recordVisitOutcome(asCurrent(tech), a.id, done({ customerConfirmed: true }));
    return a;
  }

  it("is decided by reviewers only; a rejection needs the reason and goes back to the technician", async () => {
    const a = await submitted();
    await expect(decideWork(asCurrent(tech), a.id, { decision: "APPROVED" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(decideWork(asCurrent(sales), a.id, { decision: "APPROVED" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(decideWork(asCurrent(admin), a.id, { decision: "REJECTED", note: "  " })).rejects.toMatchObject({ fieldErrors: { note: "Say why the work is sent back." } });

    const after = await decideWork(asCurrent(admin), a.id, { decision: "REJECTED", note: "The after photos do not show the handle." });
    expect(after).toMatchObject({ status: "REJECTED", can: { review: false } });
    expect((await evidenceStatus(asCurrent(tech), a.id)).can.resubmit).toBe(true);
    const n = await prisma.notification.findFirst({ where: { userId: tech.id, type: "EVIDENCE" } });
    expect(n?.message).toContain("The after photos do not show the handle.");
    // Nothing waits any more; it is listed as sent back.
    expect(await reviewQueue(asCurrent(admin))).toEqual([]);
    expect(await reviewQueue(asCurrent(admin), "REJECTED")).toMatchObject([{ appointmentId: a.id, note: "The after photos do not show the handle." }]);
    // A decision needs submitted work.
    await expect(decideWork(asCurrent(admin), a.id, { decision: "APPROVED" })).rejects.toMatchObject({ rawFieldErrors: { _form: expect.stringContaining("evidence.errors.notSubmitted") } });
  });

  it("is resubmitted by the technician once corrected, then approved", async () => {
    const a = await submitted();
    await expect(resubmitWork(asCurrent(tech), a.id, { customerConfirmed: true })).rejects.toBeInstanceOf(ValidationError); // not rejected yet
    await decideWork(asCurrent(admin), a.id, { decision: "REJECTED", note: "Video is too dark" });

    await expect(resubmitWork(asCurrent(otherTech), a.id, { customerConfirmed: true })).rejects.toBeInstanceOf(NotFoundError);
    // The confirmation is given again with each submission.
    await expect(resubmitWork(asCurrent(tech), a.id, {})).rejects.toMatchObject({ rawFieldErrors: { _form: expect.stringContaining("evidence.missing.confirmation") } });
    await uploadAttachment(asCurrent(tech), a.id, "VIDEO", WEBM);
    const again = await resubmitWork(asCurrent(tech), a.id, { customerConfirmed: true, customerName: "Mona", note: "New video in daylight" });
    expect(again.status).toBe("SUBMITTED");
    expect(await prisma.auditLog.count({ where: { appointmentId: a.id, action: "WORK_RESUBMITTED" } })).toBe(1);

    const approved = await decideWork(asCurrent(admin), a.id, { decision: "APPROVED", note: "" });
    expect(approved.status).toBe("APPROVED");
    expect(approved.history.map((h) => h.event)).toEqual(["SUBMITTED", "REJECTED", "SUBMITTED", "APPROVED"]);
    await expect(resubmitWork(asCurrent(tech), a.id, { customerConfirmed: true })).rejects.toMatchObject({ rawFieldErrors: { _form: expect.stringContaining("evidence.errors.approved") } });
    await expect(decideWork(asCurrent(admin), a.id, { decision: "REJECTED", note: "changed my mind" })).rejects.toBeInstanceOf(ValidationError);
    expect(await reviewQueue(asCurrent(admin), "APPROVED")).toHaveLength(1);
    await expect(reviewQueue(asCurrent(tech))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("goes on when the rule is switched off later, and keeps its history", async () => {
    const a = await submitted();
    await decideWork(asCurrent(admin), a.id, { decision: "REJECTED", note: "Blurry" });
    await saveEvidenceRule(asCurrent(admin), { ...FULL, isActive: false });
    const s = await evidenceStatus(asCurrent(tech), a.id);
    expect(s).toMatchObject({ rule: null, status: "REJECTED", can: { resubmit: true } });
    expect(s.history.map((h) => h.event)).toEqual(["SUBMITTED", "REJECTED"]);
    // Nothing is required any more, so the corrected work can be submitted as it is.
    expect((await resubmitWork(asCurrent(tech), a.id, {})).status).toBe("SUBMITTED");
  });

  it("keeps its history append-only, and a rejection always says why", async () => {
    const a = await submitted();
    const row = await prisma.workReview.findFirstOrThrow({ where: { appointmentId: a.id } });
    await expect(prisma.workReview.update({ where: { id: row.id }, data: { note: "edited" } })).rejects.toThrow(/append-only/);
    await expect(prisma.workReview.delete({ where: { id: row.id } })).rejects.toThrow(/append-only/);
    await expect(prisma.workReview.create({ data: { appointmentId: a.id, event: "REJECTED", actorId: admin.id } })).rejects.toThrow(/work_reviews_reason_check/);
  });
});

describe("videos", () => {
  it("are recognised from their own bytes", () => {
    expect(detectVideoType(MP4)).toBe("video/mp4");
    expect(detectVideoType(MOV)).toBe("video/quicktime");
    expect(detectVideoType(WEBM)).toBe("video/webm");
    expect(detectVideoType(MKV)).toBeNull();
    expect(detectVideoType(JPEG)).toBeNull();
    expect(detectVideoType(new Uint8Array([0, 0, 0, 0x14, ...ascii("ftypM4A "), 0, 0]))).toBeNull(); // audio
  });

  it("are uploaded only as videos, by whoever reports the visit, at most three", async () => {
    const a = await book();
    await expect(uploadAttachment(asCurrent(tech), a.id, "VIDEO", JPEG)).rejects.toMatchObject({ fieldErrors: { file: "Only MP4, MOV (QuickTime) or WebM videos can be uploaded." } });
    await expect(uploadAttachment(asCurrent(tech), a.id, "AFTER_PHOTO", MP4)).rejects.toMatchObject({ fieldErrors: { file: expect.stringContaining("JPEG") } });
    await expect(uploadAttachment(asCurrent(otherTech), a.id, "VIDEO", MP4)).rejects.toBeInstanceOf(NotFoundError);
    await expect(uploadAttachment(asCurrent(tech), a.id, "VIDEO", null)).rejects.toMatchObject({ fieldErrors: { file: expect.stringContaining("at most 50 MB") } });

    const v = await uploadAttachment(asCurrent(tech), a.id, "VIDEO", MOV);
    expect(v).toMatchObject({ kind: "VIDEO", contentType: "video/quicktime" });
    await uploadAttachment(asCurrent(tech), a.id, "VIDEO", MP4);
    await uploadAttachment(asCurrent(sales), a.id, "VIDEO", WEBM);
    await expect(uploadAttachment(asCurrent(tech), a.id, "VIDEO", MP4)).rejects.toMatchObject({ fieldErrors: { file: "A visit can have at most 3 videos." } });

    const located = await locateAttachment(asCurrent(tech), v.id);
    expect(located).toMatchObject({ contentType: "video/quicktime", size: MOV.byteLength });
    await expect(locateAttachment(asCurrent(otherTech), v.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("are kept apart from images by the database too", async () => {
    const a = await book();
    const base = { appointmentId: a.id, byteSize: 10, sha256: "x", uploadedById: tech.id };
    await expect(prisma.attachment.create({ data: { ...base, kind: "VIDEO", contentType: "image/jpeg", storageKey: "k1" } })).rejects.toThrow(/attachments_video_kind_check/);
    await expect(prisma.attachment.create({ data: { ...base, kind: "AFTER_PHOTO", contentType: "video/mp4", storageKey: "k2" } })).rejects.toThrow(/attachments_video_kind_check/);
    await expect(prisma.attachment.create({ data: { ...base, kind: "VIDEO", contentType: "video/x-matroska", storageKey: "k3" } })).rejects.toThrow(/attachments_contentType_check/);
  });

  it("answer range requests", () => {
    expect(parseRange(null, 1000)).toBeNull();
    expect(parseRange("bytes=0-", 1000)).toEqual({ start: 0, end: 999 });
    expect(parseRange("bytes=100-199", 1000)).toEqual({ start: 100, end: 199 });
    expect(parseRange("bytes=900-5000", 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange("bytes=-100", 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange("bytes=1000-", 1000)).toBe("unsatisfiable");
    expect(parseRange("bytes=5-2", 1000)).toBe("unsatisfiable");
    expect(parseRange("bytes=0-1,5-6", 1000)).toBeNull(); // several ranges: the whole file
    expect(parseRange("items=0-1", 1000)).toBeNull();
  });
});
