import "server-only";
import { Prisma } from "@prisma/client";
import type { z } from "zod";
import { canSeeCosts as canSeeCostsFor, type Permission } from "@/lib/permissions";
import { todayKey } from "@/lib/time";
import { msg } from "@/i18n/translator";
import { fieldErrorsFromZod } from "@/lib/validation";
import type { Tx } from "../db";
import { hasPermission, vehicleScoped } from "../access";
import type { CurrentUser } from "../auth/session";
import { NotFoundError, ValidationError } from "../errors";

/**
 * Shared pieces of the inventory services: who sees which warehouse, the locks that keep
 * concurrent postings consistent, document numbers and decimal helpers.
 */

export const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
export const ZERO = new Prisma.Decimal(0);
export const num = (d: Prisma.Decimal | null | undefined): number => (d ? d.toNumber() : 0);
export const numOrNull = (d: Prisma.Decimal | null | undefined): number | null => (d ? d.toNumber() : null);

export const dbDate = (key: string) => new Date(`${key}T00:00:00.000Z`);
export const keyOf = (d: Date) => d.toISOString().slice(0, 10);
export const today = (user: CurrentUser, now = new Date()) => todayKey(user.settings.timezone, now);

export function canSeeCosts(user: CurrentUser): boolean {
  return canSeeCostsFor(new Set(user.permissions));
}

export function canViewInventory(user: CurrentUser): boolean {
  return hasPermission(user, "inventory.view") || hasPermission(user, "warehouses.view");
}

/**
 * Row-level restriction for warehouses: technicians see only their own vehicle; everyone else
 * with inventory or warehouse access sees all of them; others none.
 */
export function warehouseScope(user: CurrentUser): Prisma.WarehouseWhereInput {
  if (!canViewInventory(user)) return { id: { in: [] } };
  if (vehicleScoped(user)) return { technicianId: user.id };
  return {};
}

/** The same restriction as SQL over a warehouses alias (for raw queries). */
export function warehouseScopeSql(user: CurrentUser, alias: string): Prisma.Sql {
  if (!canViewInventory(user)) return Prisma.sql`FALSE`;
  if (vehicleScoped(user)) return Prisma.sql`${Prisma.raw(`${alias}."technicianId"`)} = ${user.id}`;
  return Prisma.sql`TRUE`;
}

/** Documents touching a warehouse the user may see. */
export function documentScope(user: CurrentUser): Prisma.StockDocumentWhereInput {
  if (!hasPermission(user, "inventory.view")) return { id: { in: [] } };
  if (vehicleScoped(user)) return { OR: [{ fromWarehouse: { technicianId: user.id } }, { toWarehouse: { technicianId: user.id } }] };
  return {};
}

export function assertAny(user: CurrentUser, perms: Permission[]) {
  if (!perms.some((p) => hasPermission(user, p))) throw new NotFoundError();
}

export function checkId(id: unknown): string {
  if (typeof id !== "string" || id.length < 1 || id.length > 64) throw new NotFoundError();
  return id;
}

/**
 * Lock order for every stock change: warehouses first (shared for postings, exclusive for a
 * stocktake starting or closing), then products (exclusive), each sorted, so two transactions
 * never wait on each other in a cycle.
 */
export async function lockWarehouses(tx: Tx, ids: string[], mode: "shared" | "exclusive") {
  for (const id of [...new Set(ids)].sort()) {
    if (mode === "shared") await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(${`inventory:warehouse:${id}`}, 0))`;
    else await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`inventory:warehouse:${id}`}, 0))`;
  }
}

export async function lockProducts(tx: Tx, ids: string[]) {
  for (const id of [...new Set(ids)].sort()) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`inventory:product:${id}`}, 0))`;
  }
}

/** Next number of a sequence such as GRN-2026 (atomic; gaps only where a transaction rolled back). */
export async function nextSequence(tx: Tx, key: string): Promise<number> {
  const rows = await tx.$queryRaw<{ lastNumber: number }[]>`
    INSERT INTO "document_sequences" ("key", "lastNumber") VALUES (${key}, 1)
    ON CONFLICT ("key") DO UPDATE SET "lastNumber" = "document_sequences"."lastNumber" + 1
    RETURNING "lastNumber"`;
  return rows[0]!.lastNumber;
}

/** A warehouse frozen by an open stocktake, if any of these is. */
export async function frozenBy(tx: Tx, warehouseIds: string[], exceptStocktakeId?: string | null) {
  if (!warehouseIds.length) return null;
  return tx.stocktake.findFirst({
    where: { warehouseId: { in: warehouseIds }, status: { in: ["COUNTING", "SUBMITTED"] }, ...(exceptStocktakeId ? { id: { not: exceptStocktakeId } } : {}) },
    select: { number: true, warehouse: { select: { code: true } } },
  });
}

export function formError(key: Parameters<typeof msg>[0], params?: Parameters<typeof msg>[1], field = "_form"): ValidationError {
  const m = msg(key, params);
  return new ValidationError({ [field]: m }, m);
}

/** "MAIN" or "MAIN / A-01" */
export function locationLabel(w: { code: string }, bin: { code: string } | null | undefined): string {
  return bin ? `${w.code} / ${bin.code}` : w.code;
}

/** Localised product name for messages: English text with its Arabic variant. */
export function productParam(name: string, p: { sku: string; nameEn: string; nameAr: string }): Record<string, string> {
  return { [name]: `${p.sku} ${p.nameEn}`, [`${name}Ar`]: `${p.sku} ${p.nameAr}` };
}

/** Pagination clamp used by every inventory list. */
export function pageOf(page: unknown, pageSize: number, max = 10_000) {
  const p = Math.max(1, Math.min(max, Math.floor(Number(page) || 1)));
  return { page: p, skip: (p - 1) * pageSize, take: pageSize };
}

/** Escapes LIKE wildcards in a user's search term. */
export function likeTerm(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Validates input with a shared schema; field errors keep their message keys. */
export function parseInput<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
  const r = schema.safeParse(raw);
  if (!r.success) throw new ValidationError(fieldErrorsFromZod(r.error));
  return r.data;
}
