import "server-only";
import type { Prisma, ProductCategory, VisitType, WorkReviewEvent } from "@prisma/client";
import { msg } from "@/i18n/translator";
import { appointmentCode } from "@/lib/constants";
import { NO_REQUIREMENT, decideWorkSchema, evidenceMissing, evidenceRuleSchema, ruleFor, submitWorkSchema, type EvidenceRequirement, type EvidenceRule, type EvidenceState, type EvidenceStatusDTO } from "@/lib/evidence";
import { fieldErrorsFromZod } from "@/lib/validation";
import { prisma, type Tx } from "../db";
import { appointmentScope, appointmentScopeSql, assertCan, hasPermission } from "../access";
import type { CurrentUser } from "../auth/session";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { recordAudit } from "./audit";
import { notifyUsers } from "./notifications";

/**
 * Work evidence: each kind of visit (visit type and product category) can require before photos,
 * after photos, a video, the customer's signature, the customer's confirmation, and a manager's
 * review. "Done" is refused while required evidence is missing. When a review is required,
 * finishing the visit submits the work; a reviewer approves it, or rejects it with a reason, and
 * the technician corrects it and submits again. Every step is an append-only event, audited.
 */

type Db = Tx | typeof prisma;

function toRule(r: Prisma.EvidenceRuleGetPayload<object>): EvidenceRule {
  return {
    id: r.id,
    visitType: (r.visitType || null) as VisitType | null,
    productCategory: (r.productCategory || null) as ProductCategory | null,
    minBeforePhotos: r.minBeforePhotos,
    minAfterPhotos: r.minAfterPhotos,
    requireVideo: r.requireVideo,
    requireSignature: r.requireSignature,
    requireCustomerConfirmation: r.requireCustomerConfirmation,
    requireReview: r.requireReview,
    isActive: r.isActive,
  };
}

export async function listEvidenceRules(user: CurrentUser): Promise<EvidenceRule[]> {
  if (!hasPermission(user, "settings.manage") && !hasPermission(user, "evidence.review")) throw new NotFoundError();
  const rows = await prisma.evidenceRule.findMany({ orderBy: [{ visitType: "asc" }, { productCategory: "asc" }] });
  return rows.map(toRule);
}

/** Creates or replaces the rule for a visit type and category (Admins). */
export async function saveEvidenceRule(user: CurrentUser, raw: unknown) {
  assertCan(user, "settings.manage");
  const parsed = evidenceRuleSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(fieldErrorsFromZod(parsed.error));
  const { visitType, productCategory, ...rest } = parsed.data;
  return prisma.$transaction(async (tx) => {
    const key = { visitType: visitType ?? "", productCategory: productCategory ?? "" };
    const before = await tx.evidenceRule.findUnique({ where: { visitType_productCategory: key } });
    const r = await tx.evidenceRule.upsert({ where: { visitType_productCategory: key }, create: { ...key, ...rest, updatedById: user.id }, update: { ...rest, updatedById: user.id } });
    await recordAudit(tx, {
      entityType: "EVIDENCE",
      entityId: r.id,
      action: before ? "EVIDENCE_RULE_UPDATED" : "EVIDENCE_RULE_CREATED",
      summary: msg("erpAudit.evidenceRule", { name: user.name, visitType: visitType ? `@enums.visitType.${visitType}` : "@evidence.anyVisit", category: productCategory ? `@enums.productCategory.${productCategory}` : "@evidence.anyCategory" }),
      changes: { before: before ? toRule(before) : null, after: toRule(r) },
      actorId: user.id,
    });
    return toRule(r);
  });
}

/** The requirement for a visit (no rule = nothing required beyond the delivery settings). */
export async function requirementFor(db: Db, visitType: VisitType | null, category: ProductCategory): Promise<{ rule: EvidenceRule | null; req: EvidenceRequirement }> {
  const rule = ruleFor((await db.evidenceRule.findMany()).map(toRule), visitType, category);
  return { rule, req: rule ?? NO_REQUIREMENT };
}

async function stateOf(db: Db, appointmentId: string, customerConfirmed: boolean): Promise<EvidenceState> {
  const kinds = await db.attachment.groupBy({ by: ["kind"], where: { appointmentId, deletedAt: null }, _count: { _all: true } });
  const count = (k: string) => kinds.find((x) => x.kind === k)?._count._all ?? 0;
  return { beforePhotos: count("BEFORE_PHOTO"), afterPhotos: count("AFTER_PHOTO"), videos: count("VIDEO"), hasSignature: count("SIGNATURE") > 0, customerConfirmed };
}

function missingText(missing: ReturnType<typeof evidenceMissing>): string {
  return missing.map((m) => msg(m.key, m.count ? { count: m.count } : undefined)).join("\n");
}

/**
 * Called by the visit outcome when a visit is marked done (in the caller's transaction). With
 * `enforce` (technicians), refuses while evidence is missing; managers may record a finished
 * visit afterwards, as with the delivery rules. When the rule asks for a review, the work is
 * submitted for it (whoever marked it done; work already approved stays approved).
 */
export async function assertEvidenceAndSubmit(
  tx: Tx,
  user: CurrentUser,
  a: { id: string; number: number; visitType: VisitType | null; productCategory: ProductCategory; createdById: string },
  input: { customerConfirmed?: boolean; customerName?: string | null },
  enforce: boolean,
) {
  const { req } = await requirementFor(tx, a.visitType, a.productCategory);
  if (req === NO_REQUIREMENT) return;
  const missing = evidenceMissing(req, await stateOf(tx, a.id, !!input.customerConfirmed));
  if (enforce && missing.length) throw new ValidationError({ outcome: missingText(missing) }, msg("evidence.notReady"));
  if (!req.requireReview) return;
  const last = await latest(tx, a.id);
  if (last?.event === "APPROVED" || last?.event === "SUBMITTED") return;
  await submitInTx(tx, user, a, last, { customerConfirmed: !!input.customerConfirmed, customerName: input.customerName ?? null, note: null });
}

async function latest(db: Db, appointmentId: string) {
  return db.workReview.findFirst({ where: { appointmentId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
}

async function reviewers(tx: Tx) {
  const users = await tx.user.findMany({ where: { isActive: true, role: "ADMIN" }, select: { id: true } });
  return users.map((u) => u.id);
}

async function submitInTx(
  tx: Tx,
  user: CurrentUser,
  a: { id: string; number: number },
  last: { event: WorkReviewEvent } | null,
  s: { customerConfirmed: boolean; customerName: string | null; note: string | null },
) {
  // The time is taken after the visit's row lock, so events of one visit are in order.
  const row = await tx.workReview.create({ data: { appointmentId: a.id, event: "SUBMITTED", note: s.note, customerConfirmed: s.customerConfirmed, customerName: s.customerName, actorId: user.id, createdAt: new Date() } });
  await recordAudit(tx, {
    entityType: "EVIDENCE",
    entityId: a.id,
    appointmentId: a.id,
    action: last ? "WORK_RESUBMITTED" : "WORK_SUBMITTED",
    summary: msg(last ? "erpAudit.workResubmitted" : "erpAudit.workSubmitted", { name: user.name, code: appointmentCode(a.number) }),
    changes: { customerConfirmed: s.customerConfirmed, customerName: s.customerName, note: s.note },
    actorId: user.id,
  });
  await notifyUsers(tx, await reviewers(tx), { appointmentId: a.id, type: "EVIDENCE", message: msg("evidence.notifySubmitted", { name: user.name, code: appointmentCode(a.number) }) }, user.id);
  return row;
}

async function visibleVisit(user: CurrentUser, appointmentId: string) {
  if (typeof appointmentId !== "string" || appointmentId.length > 64) throw new NotFoundError("errors.appointmentNotFound");
  const a = await prisma.appointment.findFirst({
    where: { AND: [{ id: appointmentId }, appointmentScope(user)] },
    select: { id: true, number: true, visitType: true, productCategory: true, createdById: true, status: { select: { kind: true } }, technicians: { select: { technicianId: true } } },
  });
  if (!a) throw new NotFoundError("errors.appointmentNotFound");
  return a;
}

/** The technician submits the corrected work again (after a rejection), with the customer's confirmation. */
export async function resubmitWork(user: CurrentUser, appointmentId: string, raw: unknown) {
  const a = await visibleVisit(user, appointmentId);
  const isTech = a.technicians.some((t) => t.technicianId === user.id);
  if (!(isTech && hasPermission(user, "visits.report")) && !hasPermission(user, "appointments.manage")) throw new ForbiddenError();
  const parsed = submitWorkSchema.safeParse(raw ?? {});
  if (!parsed.success) throw new ValidationError(fieldErrorsFromZod(parsed.error));
  await prisma.$transaction(async (tx) => {
    // One decision or submission per visit at a time, so the latest event is exact.
    await tx.$queryRaw`SELECT id FROM appointments WHERE id = ${a.id} FOR UPDATE`;
    const last = await latest(tx, a.id);
    if (last?.event !== "REJECTED") {
      const text = msg(last?.event === "APPROVED" ? "evidence.errors.approved" : "evidence.errors.notRejected");
      throw new ValidationError({ _form: text }, text);
    }
    const { req } = await requirementFor(tx, a.visitType, a.productCategory);
    const missing = evidenceMissing(req, await stateOf(tx, a.id, !!parsed.data.customerConfirmed));
    if (missing.length) throw new ValidationError({ _form: missingText(missing) }, msg("evidence.notReady"));
    await submitInTx(tx, user, a, last, { customerConfirmed: !!parsed.data.customerConfirmed, customerName: parsed.data.customerName, note: parsed.data.note });
  });
  return evidenceStatus(user, appointmentId);
}

/** A reviewer approves the submitted work, or rejects it with the reason. */
export async function decideWork(user: CurrentUser, appointmentId: string, raw: unknown) {
  assertCan(user, "evidence.review");
  const a = await visibleVisit(user, appointmentId);
  const parsed = decideWorkSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(fieldErrorsFromZod(parsed.error));
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM appointments WHERE id = ${a.id} FOR UPDATE`;
    const last = await latest(tx, a.id);
    if (last?.event !== "SUBMITTED") throw new ValidationError({ _form: msg("evidence.errors.notSubmitted") }, msg("evidence.errors.notSubmitted"));
    const event: WorkReviewEvent = parsed.data.decision;
    await tx.workReview.create({ data: { appointmentId: a.id, event, note: parsed.data.note, actorId: user.id, createdAt: new Date() } });
    await recordAudit(tx, {
      entityType: "EVIDENCE",
      entityId: a.id,
      appointmentId: a.id,
      action: event === "APPROVED" ? "WORK_APPROVED" : "WORK_REJECTED",
      summary: msg(event === "APPROVED" ? "erpAudit.workApproved" : "erpAudit.workRejected", {
        name: user.name,
        code: appointmentCode(a.number),
        reason: event === "APPROVED" ? (parsed.data.note ? `(${parsed.data.note})` : "") : (parsed.data.note ?? ""),
      }),
      changes: { decision: event, note: parsed.data.note },
      actorId: user.id,
    });
    const to = [...new Set([...a.technicians.map((t) => t.technicianId), a.createdById])];
    await notifyUsers(tx, to, {
      appointmentId: a.id,
      type: "EVIDENCE",
      message: event === "APPROVED" ? msg("evidence.notifyApproved", { code: appointmentCode(a.number) }) : msg("evidence.notifyRejected", { code: appointmentCode(a.number), reason: parsed.data.note ?? "" }),
    }, user.id);
  });
  return evidenceStatus(user, appointmentId);
}

/** What a visit requires, what it has, what is missing, and the review history. */
export async function evidenceStatus(user: CurrentUser, appointmentId: string): Promise<EvidenceStatusDTO> {
  const a = await visibleVisit(user, appointmentId);
  const [{ rule, req }, history] = await Promise.all([
    requirementFor(prisma, a.visitType, a.productCategory),
    prisma.workReview.findMany({ where: { appointmentId: a.id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], include: { actor: { select: { id: true, name: true } } } }),
  ]);
  const last = history[history.length - 1] ?? null;
  const lastSubmit = [...history].reverse().find((h) => h.event === "SUBMITTED");
  const state = await stateOf(prisma, a.id, !!lastSubmit?.customerConfirmed);
  const isTech = a.technicians.some((t) => t.technicianId === user.id);
  return {
    rule: rule ? { ...req, visitType: rule.visitType, productCategory: rule.productCategory } : null,
    state,
    missing: evidenceMissing(req, state),
    status: (last?.event ?? null) as WorkReviewEvent | null,
    history: history.map((h) => ({ id: h.id, event: h.event, note: h.note, customerConfirmed: h.customerConfirmed, customerName: h.customerName, actor: h.actor, at: h.createdAt.toISOString() })),
    can: {
      review: hasPermission(user, "evidence.review") && last?.event === "SUBMITTED",
      resubmit: ((isTech && hasPermission(user, "visits.report")) || hasPermission(user, "appointments.manage")) && last?.event === "REJECTED",
    },
  };
}

/** Visits whose latest review event is `status` (waiting, sent back or approved), newest first, for the review queue. */
export async function reviewQueue(user: CurrentUser, status: WorkReviewEvent = "SUBMITTED", limit = 200) {
  assertCan(user, "evidence.review");
  // The latest event of each visit (index on appointmentId, createdAt), then only that status.
  const rows = await prisma.$queryRaw<{ appointmentId: string; event: WorkReviewEvent; createdAt: Date; actorName: string; note: string | null; number: number; customerName: string; startsAt: Date }[]>`
    SELECT l."appointmentId", l.event, l."createdAt", u.name AS "actorName", l.note, a.number, c.name AS "customerName", a."startsAt"
    FROM (
      SELECT DISTINCT ON (w."appointmentId") w."appointmentId", w.event, w."createdAt", w."actorId", w.note
      FROM work_reviews w
      ORDER BY w."appointmentId", w."createdAt" DESC, w.id DESC
    ) l
    JOIN users u ON u.id = l."actorId"
    JOIN appointments a ON a.id = l."appointmentId"
    JOIN customers c ON c.id = a."customerId"
    WHERE l.event = ${status}::"WorkReviewEvent" AND ${appointmentScopeSql(user)}
    ORDER BY l."createdAt" DESC
    LIMIT ${limit}`;
  return rows.map((r) => ({ appointmentId: r.appointmentId, code: appointmentCode(r.number), customerName: r.customerName, startsAt: r.startsAt.toISOString(), event: r.event, at: r.createdAt.toISOString(), by: r.actorName, note: r.note }));
}
