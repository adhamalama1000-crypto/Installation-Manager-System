import "server-only";
import { Prisma } from "@prisma/client";
import { createT, msg } from "@/i18n/translator";
import { prisma, type Db } from "../db";
import { currentRequestContext } from "../request-context";
import { messageData } from "./notifications";

const english = createT("en");

export const AUDIT_ENTITY_TYPES = [
  "APPOINTMENT",
  "USER",
  "STATUS",
  "SETTINGS",
  "CUSTOMER",
  "LEAVE",
  "CASH",
  "STOCK",
  "COMPLAINT",
  "EXPENSE",
  "PRODUCT",
  "WAREHOUSE",
  "INVENTORY",
  "STOCKTAKE",
  "SUPPLIER",
  "SALE",
  "ATTENDANCE",
  "EVIDENCE",
  "PENALTY",
  "FINANCE",
  "AUTH",
  "REPORT",
  "AUDIT",
] as const;
export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

/** The module (src/lib/permission-registry.ts) each record type belongs to; sign-in is "auth". */
export const MODULE_OF_ENTITY: Record<AuditEntityType, string> = {
  APPOINTMENT: "appointments",
  USER: "users",
  STATUS: "settings",
  SETTINGS: "settings",
  CUSTOMER: "customers",
  LEAVE: "leaves",
  CASH: "finance",
  STOCK: "serialCustody",
  COMPLAINT: "complaints",
  EXPENSE: "expenses",
  PRODUCT: "products",
  WAREHOUSE: "warehouses",
  INVENTORY: "inventory",
  STOCKTAKE: "inventory",
  SUPPLIER: "suppliers",
  SALE: "sales",
  ATTENDANCE: "attendance",
  EVIDENCE: "workReview",
  PENALTY: "penalties",
  FINANCE: "finance",
  AUTH: "auth",
  REPORT: "reports",
  AUDIT: "audit",
};

export type AuditInput = {
  entityType: AuditEntityType;
  entityId: string;
  action: string;
  /** Encoded message (i18n `msg`): stored in English plus its key and params for other languages. */
  summary: string;
  changes?: Record<string, unknown> | null;
  actorId: string | null;
  appointmentId?: string | null;
  /** The module, when it is not the record type's own (e.g. a report exported from the appointments list). */
  module?: string;
  /** Why an administrative correction, cancellation or reversal was made. */
  reason?: string | null;
};

const SECRET_KEY = /pass(word)?|token|secret|hash|cookie|authorization|session/i;

/** Drops anything that looks like a credential, at any depth, so audit entries never hold secrets. */
export function sanitizeChanges(v: unknown, depth = 0): unknown {
  if (depth > 6 || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => sanitizeChanges(x, depth + 1));
  // Only plain objects are walked; values such as dates and decimals are kept as they are.
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (SECRET_KEY.test(k)) continue;
    out[k] = sanitizeChanges(x, depth + 1);
  }
  return out;
}

/**
 * Writes an audit entry (inside the caller's transaction when given one, so it is recorded exactly
 * when the change is). The request context (IP, user agent, method, path) comes from the request
 * being served. Entries are never updated or deleted (database triggers).
 */
export async function recordAudit(db: Db, entry: AuditInput) {
  const ctx = currentRequestContext();
  await db.auditLog.create({
    data: {
      entityType: entry.entityType,
      entityId: entry.entityId,
      action: entry.action,
      module: entry.module ?? MODULE_OF_ENTITY[entry.entityType] ?? null,
      reason: entry.reason ? entry.reason.slice(0, 1000) : null,
      context: ctx ? (ctx as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
      summary: english.msg(entry.summary).slice(0, 500),
      summaryData: messageData(entry.summary) ?? Prisma.DbNull,
      changes: entry.changes ? (sanitizeChanges(entry.changes) as Prisma.InputJsonValue) : Prisma.DbNull,
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

export type ExportWhat = "appointments" | "report" | "finance" | "balances" | "ledger" | "products" | "audit";

/** Records a data export (who exported what, with which filters and how many rows). */
export async function recordExport(user: { id: string; name: string }, what: ExportWhat, entityType: AuditEntityType, details: Record<string, unknown>) {
  await recordAudit(prisma, {
    entityType,
    entityId: `export:${what}`,
    action: "EXPORTED",
    summary: msg("exportAudit.exported", { name: user.name, what: `@exportAudit.what.${what}` }),
    changes: details,
    actorId: user.id,
  });
}
