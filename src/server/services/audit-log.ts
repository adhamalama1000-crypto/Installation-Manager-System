import "server-only";
import type { Prisma } from "@prisma/client";
import type { AuditEntryDTO } from "@/lib/types";
import { dayRangeUtc, isValidDateString } from "@/lib/time";
import { prisma } from "../db";
import { assertCan } from "../access";
import type { CurrentUser } from "../auth/session";

export const AUDIT_ENTITY_TYPES = ["APPOINTMENT", "USER", "STATUS", "SETTINGS", "CUSTOMER"] as const;

export async function listAuditLog(
  user: CurrentUser,
  opts: { entityType?: string; actorId?: string; from?: string; to?: string; q?: string; page?: number },
) {
  assertCan(user, "audit.view");
  const pageSize = 50;
  const page = Math.max(1, Math.min(10_000, opts.page ?? 1));
  const and: Prisma.AuditLogWhereInput[] = [];
  if (opts.entityType && (AUDIT_ENTITY_TYPES as readonly string[]).includes(opts.entityType)) and.push({ entityType: opts.entityType });
  if (opts.actorId) and.push({ actorId: opts.actorId.slice(0, 64) });
  if ((opts.from && isValidDateString(opts.from)) || (opts.to && isValidDateString(opts.to))) {
    const r = dayRangeUtc(
      opts.from && isValidDateString(opts.from) ? opts.from : "1970-01-01",
      opts.to && isValidDateString(opts.to) ? opts.to : "9999-12-30",
      user.settings.timezone,
    );
    and.push({ createdAt: { gte: r.start, lt: r.end } });
  }
  if (opts.q?.trim()) and.push({ summary: { contains: opts.q.trim().slice(0, 100), mode: "insensitive" } });
  const where: Prisma.AuditLogWhereInput = and.length ? { AND: and } : {};
  const [total, rows] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({
      where,
      include: { actor: { select: { id: true, name: true } } },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);
  const items: AuditEntryDTO[] = rows.map((r) => ({
    id: r.id,
    action: r.action,
    summary: r.summary,
    changes: (r.changes as AuditEntryDTO["changes"]) ?? null,
    actor: r.actor,
    createdAt: r.createdAt.toISOString(),
    entityType: r.entityType,
    entityId: r.entityId,
    appointmentId: r.appointmentId,
  }));
  return { items, total, page, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}
