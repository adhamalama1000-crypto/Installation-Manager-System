import "server-only";
import { Prisma } from "@prisma/client";
import type { Db } from "../db";

export type AuditInput = {
  entityType: "APPOINTMENT" | "USER" | "STATUS" | "SETTINGS" | "CUSTOMER" | "LEAVE" | "CASH" | "STOCK";
  entityId: string;
  action: string;
  summary: string;
  changes?: Record<string, unknown> | null;
  actorId: string | null;
  appointmentId?: string | null;
};

export async function recordAudit(db: Db, entry: AuditInput) {
  await db.auditLog.create({
    data: {
      entityType: entry.entityType,
      entityId: entry.entityId,
      action: entry.action,
      summary: entry.summary.slice(0, 500),
      changes: entry.changes ? (entry.changes as Prisma.InputJsonValue) : Prisma.DbNull,
      actorId: entry.actorId,
      appointmentId: entry.appointmentId ?? null,
    },
  });
}

function normalize(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Prisma.Decimal) return v.toNumber();
  if (v === undefined || v === "") return null;
  if (Array.isArray(v)) return [...v].map(normalize);
  return v;
}

/** Returns { field: { from, to } } for every key whose value differs. */
export function diffValues(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  keys: string[] = Object.keys(after),
): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of keys) {
    const a = normalize(before[key]);
    const b = normalize(after[key]);
    if (JSON.stringify(a) !== JSON.stringify(b)) out[key] = { from: a, to: b };
  }
  return out;
}
