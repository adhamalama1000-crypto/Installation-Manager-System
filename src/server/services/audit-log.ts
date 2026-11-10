import "server-only";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { msg } from "@/i18n/translator";
import { MODULES } from "@/lib/permission-registry";
import type { AuditEntryDTO } from "@/lib/types";
import { dayRangeUtc, isValidDateString } from "@/lib/time";
import { prisma } from "../db";
import { assertCan } from "../access";
import type { CurrentUser } from "../auth/session";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { escapeLike } from "./appointment-reads";
import { AUDIT_ENTITY_TYPES, recordAudit, recordExport } from "./audit";
import { localized } from "./notifications";
import { toCsv } from "./reports";

export { AUDIT_ENTITY_TYPES };

/** Every module an audit entry can belong to (the registry's, plus sign-in). */
export const AUDIT_MODULES = [...MODULES.map((m) => m.id), "auth"];

export type AuditFilters = { entityType?: string; entityId?: string; module?: string; action?: string; actorId?: string; from?: string; to?: string; q?: string; page?: number };

/** The audit log is the Admin's alone (audit.view is an Admin-only permission). */
function assertAuditor(user: CurrentUser) {
  assertCan(user, "audit.view");
  if (user.role !== "ADMIN") throw new ForbiddenError();
}

function whereOf(user: CurrentUser, opts: AuditFilters): Prisma.AuditLogWhereInput {
  const and: Prisma.AuditLogWhereInput[] = [];
  if (opts.entityType && (AUDIT_ENTITY_TYPES as readonly string[]).includes(opts.entityType)) and.push({ entityType: opts.entityType });
  if (opts.entityId?.trim()) and.push({ entityId: opts.entityId.trim().slice(0, 254) });
  if (opts.module && AUDIT_MODULES.includes(opts.module)) and.push({ module: opts.module });
  if (opts.action && /^[A-Z_]{2,60}$/.test(opts.action)) and.push({ action: opts.action });
  if (opts.actorId) and.push({ actorId: opts.actorId.slice(0, 64) });
  if ((opts.from && isValidDateString(opts.from)) || (opts.to && isValidDateString(opts.to))) {
    const r = dayRangeUtc(
      opts.from && isValidDateString(opts.from) ? opts.from : "1970-01-01",
      opts.to && isValidDateString(opts.to) ? opts.to : "9999-12-30",
      user.settings.timezone,
    );
    and.push({ createdAt: { gte: r.start, lt: r.end } });
  }
  if (opts.q?.trim()) and.push({ summary: { contains: escapeLike(opts.q.trim().slice(0, 100)), mode: "insensitive" } });
  return and.length ? { AND: and } : {};
}

type Row = Prisma.AuditLogGetPayload<{ include: { actor: { select: { id: true; name: true } } } }>;

function toDTO(user: CurrentUser, r: Row): AuditEntryDTO {
  return {
    id: r.id,
    action: r.action,
    summary: localized(r.summaryData, r.summary, user.locale),
    changes: (r.changes as AuditEntryDTO["changes"]) ?? null,
    actor: r.actor,
    createdAt: r.createdAt.toISOString(),
    entityType: r.entityType,
    entityId: r.entityId,
    appointmentId: r.appointmentId,
    module: r.module,
    reason: r.reason,
    context: (r.context as AuditEntryDTO["context"]) ?? null,
  };
}

export async function listAuditLog(user: CurrentUser, opts: AuditFilters) {
  assertAuditor(user);
  const pageSize = 50;
  const page = Math.max(1, Math.min(10_000, opts.page ?? 1));
  const where = whereOf(user, opts);
  const [total, rows] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({ where, include: { actor: { select: { id: true, name: true } } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (page - 1) * pageSize, take: pageSize }),
  ]);
  return { items: rows.map((r) => toDTO(user, r)), total, page, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

/** The actions that occur in the log (for the filter). */
export async function auditActions(user: CurrentUser): Promise<string[]> {
  assertAuditor(user);
  const rows = await prisma.auditLog.findMany({ distinct: ["action"], select: { action: true }, orderBy: { action: "asc" } });
  return rows.map((r) => r.action);
}

const AUDIT_EXPORT_LIMIT = 20_000;

/** The filtered log as CSV (Admin). The export itself is recorded in the log. */
export async function exportAuditCsv(user: CurrentUser, opts: AuditFilters): Promise<string> {
  assertAuditor(user);
  const where = whereOf(user, opts);
  const rows = await prisma.auditLog.findMany({ where, include: { actor: { select: { id: true, name: true } } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: AUDIT_EXPORT_LIMIT });
  await recordExport(user, "audit", "AUDIT", { filters: opts, rows: rows.length });
  return toCsv([
    ["time", "actor", "module", "action", "entityType", "entityId", "summary", "reason", "ip", "changes"],
    ...rows.map((r) => {
      const d = toDTO(user, r);
      return [d.createdAt, d.actor?.name ?? "", d.module ?? "", d.action, d.entityType, d.entityId, d.summary, d.reason ?? "", d.context?.ip ?? "", d.changes ? JSON.stringify(d.changes) : ""];
    }),
  ]);
}

const correctionSchema = z.object({
  reason: z.preprocess((v) => (typeof v === "string" ? v.trim() : v), z.string({ error: msg("auditLog.errors.reason") }).min(1, msg("auditLog.errors.reason")).max(1000)),
  note: z.preprocess((v) => (typeof v === "string" ? v.trim() : v), z.string({ error: msg("auditLog.errors.note") }).min(1, msg("auditLog.errors.note")).max(2000)),
});

/**
 * Records an administrative correction of an earlier entry. History is never rewritten: the
 * correction is a new entry for the same record, pointing to the corrected one, with its reason.
 */
export async function recordCorrection(user: CurrentUser, auditId: string, raw: unknown) {
  assertAuditor(user);
  const parsed = correctionSchema.safeParse(raw);
  if (!parsed.success) {
    const e: Record<string, string> = {};
    for (const i of parsed.error.issues) e[String(i.path[0] ?? "_form")] = i.message;
    throw new ValidationError(e);
  }
  if (typeof auditId !== "string" || auditId.length > 64) throw new NotFoundError();
  const original = await prisma.auditLog.findUnique({ where: { id: auditId } });
  if (!original) throw new NotFoundError();
  await recordAudit(prisma, {
    entityType: original.entityType as (typeof AUDIT_ENTITY_TYPES)[number],
    entityId: original.entityId,
    appointmentId: original.appointmentId,
    module: original.module ?? undefined,
    action: "AUDIT_CORRECTION",
    summary: msg("auditLog.correctionSummary", { name: user.name, note: parsed.data.note.slice(0, 300) }),
    reason: parsed.data.reason,
    changes: { correctsAuditId: original.id, correctsAction: original.action, note: parsed.data.note },
    actorId: user.id,
  });
  return { ok: true };
}
