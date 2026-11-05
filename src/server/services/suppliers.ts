import "server-only";
import type { Prisma } from "@prisma/client";
import { msg } from "@/i18n/translator";
import { phoneDigits } from "@/lib/constants";
import { supplierSchema } from "@/lib/suppliers";
import { prisma } from "../db";
import { assertCan, hasPermission } from "../access";
import type { CurrentUser } from "../auth/session";
import { NotFoundError, StaleRecordError, ValidationError } from "../errors";
import { diffValues, recordAudit } from "./audit";
import { isUniqueViolation } from "./scheduling";
import { checkId, likeTerm, nextSequence, pageOf, parseInput } from "./inventory-common";

/**
 * Supplier master. Receipts and supplier returns can name a supplier from here (the name is also
 * kept as text on the document, as before). Suppliers are deactivated, never deleted (trigger).
 */

export type SupplierDTO = {
  id: string;
  code: string;
  name: string;
  nameAr: string | null;
  contactPerson: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  taxNumber: string | null;
  notes: string | null;
  isActive: boolean;
  version: number;
  documentCount: number;
  lastDocumentDate: string | null;
};

const AUDITED = ["code", "name", "nameAr", "contactPerson", "phone", "email", "address", "taxNumber", "notes", "isActive"];

export function canViewSuppliers(user: CurrentUser) {
  return hasPermission(user, "suppliers.view") || hasPermission(user, "suppliers.manage");
}

function toDTO(s: Prisma.SupplierGetPayload<{ include: { _count: { select: { documents: true } } } }>, last: Date | null = null): SupplierDTO {
  return {
    id: s.id,
    code: s.code,
    name: s.name,
    nameAr: s.nameAr,
    contactPerson: s.contactPerson,
    phone: s.phone,
    email: s.email,
    address: s.address,
    taxNumber: s.taxNumber,
    notes: s.notes,
    isActive: s.isActive,
    version: s.version,
    documentCount: s._count.documents,
    lastDocumentDate: last ? last.toISOString().slice(0, 10) : null,
  };
}

export async function listSuppliers(user: CurrentUser, f: { q?: string; active?: string; page?: number; pageSize?: number } = {}) {
  if (!canViewSuppliers(user)) throw new NotFoundError();
  const pageSize = Math.min(100, Math.max(5, f.pageSize ?? 25));
  const { page, skip, take } = pageOf(f.page, pageSize);
  const and: Prisma.SupplierWhereInput[] = [];
  const q = f.q?.trim().slice(0, 100);
  if (q) {
    const digits = phoneDigits(q);
    and.push({
      OR: [
        { name: { contains: q, mode: "insensitive" } },
        { nameAr: { contains: q, mode: "insensitive" } },
        { code: { contains: q.toUpperCase() } },
        { contactPerson: { contains: q, mode: "insensitive" } },
        ...(digits.length >= 4 ? [{ phoneDigits: { contains: digits } }] : []),
      ],
    });
  }
  if (f.active !== "all") and.push({ isActive: f.active !== "0" });
  const where = and.length ? { AND: and } : {};
  const [total, rows] = await Promise.all([
    prisma.supplier.count({ where }),
    prisma.supplier.findMany({ where, include: { _count: { select: { documents: true } } }, orderBy: [{ isActive: "desc" }, { name: "asc" }], skip, take }),
  ]);
  const last = rows.length
    ? await prisma.stockDocument.groupBy({ by: ["supplierId"], where: { supplierId: { in: rows.map((r) => r.id) }, status: "POSTED" }, _max: { documentDate: true } })
    : [];
  const lastBy = new Map(last.map((l) => [l.supplierId, l._max.documentDate]));
  return { total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)), rows: rows.map((r) => toDTO(r, lastBy.get(r.id) ?? null)) };
}

export async function getSupplier(user: CurrentUser, id: string) {
  if (!canViewSuppliers(user)) throw new NotFoundError();
  const s = await prisma.supplier.findUnique({ where: { id: checkId(id) }, include: { _count: { select: { documents: true } } } });
  if (!s) throw new NotFoundError();
  const docs = hasPermission(user, "inventory.view")
    ? await prisma.stockDocument.findMany({
        where: { supplierId: s.id },
        orderBy: [{ documentDate: "desc" }, { createdAt: "desc" }],
        take: 50,
        select: { id: true, number: true, type: true, returnKind: true, status: true, documentDate: true, reference: true, _count: { select: { lines: true } } },
      })
    : [];
  return { ...toDTO(s, docs.find((d) => d.status === "POSTED")?.documentDate ?? null), documents: docs.map((d) => ({ ...d, documentDate: d.documentDate.toISOString().slice(0, 10), lines: d._count.lines })) };
}

export async function saveSupplier(user: CurrentUser, id: string | null, raw: unknown): Promise<SupplierDTO> {
  assertCan(user, "suppliers.manage");
  const { version, code: codeIn, ...data } = parseInput(supplierSchema, raw);
  try {
    return await prisma.$transaction(async (tx) => {
      const before = id ? await tx.supplier.findUnique({ where: { id: checkId(id) } }) : null;
      if (id && !before) throw new NotFoundError();
      if (before && version !== undefined && version !== before.version) throw new StaleRecordError();
      const dupName = await tx.supplier.findFirst({ where: { name: { equals: data.name, mode: "insensitive" }, id: before ? { not: before.id } : undefined }, select: { id: true } });
      if (dupName) throw new ValidationError({ name: msg("suppliers.errors.nameTaken") });
      let code = codeIn ?? before?.code ?? null;
      if (code && (await tx.supplier.findFirst({ where: { code, id: before ? { not: before.id } : undefined }, select: { id: true } }))) throw new ValidationError({ code: msg("suppliers.errors.codeTaken") });
      if (!code) {
        for (let i = 0; i < 500 && !code; i++) {
          const candidate = `SUP-${String(await nextSequence(tx, "SUPPLIER")).padStart(5, "0")}`;
          if (!(await tx.supplier.findUnique({ where: { code: candidate }, select: { id: true } }))) code = candidate;
        }
        if (!code) throw new ValidationError({ code: msg("suppliers.errors.code") });
      }
      const values = { ...data, code, phoneDigits: data.phone ? phoneDigits(data.phone) : null };
      const s = before
        ? await tx.supplier.update({ where: { id: before.id }, data: { ...values, version: { increment: 1 } }, include: { _count: { select: { documents: true } } } })
        : await tx.supplier.create({ data: { ...values, createdById: user.id }, include: { _count: { select: { documents: true } } } });
      await recordAudit(tx, {
        entityType: "SUPPLIER",
        entityId: s.id,
        action: before ? "SUPPLIER_UPDATED" : "SUPPLIER_CREATED",
        summary: msg(before ? "erpAudit.supplierUpdated" : "erpAudit.supplierCreated", { name: user.name, code: s.code, supplier: s.name }),
        changes: before ? diffValues(before, s, AUDITED) : Object.fromEntries(AUDITED.map((k) => [k, (s as Record<string, unknown>)[k]])),
        actorId: user.id,
      });
      return toDTO(s);
    });
  } catch (e) {
    if (isUniqueViolation(e, "code")) throw new ValidationError({ code: msg("suppliers.errors.codeTaken") });
    throw e;
  }
}

/** Active suppliers matching a search, for pickers on documents. */
export async function supplierOptions(user: CurrentUser, q: string) {
  if (!canViewSuppliers(user) && !hasPermission(user, "inventory.receive") && !hasPermission(user, "inventory.issue")) throw new NotFoundError();
  const term = q.trim().slice(0, 100);
  const rows = await prisma.supplier.findMany({
    where: { isActive: true, ...(term ? { OR: [{ name: { contains: term, mode: "insensitive" } }, { nameAr: { contains: term, mode: "insensitive" } }, { code: { contains: term.toUpperCase() } }] } : {}) },
    orderBy: { name: "asc" },
    take: 20,
    select: { id: true, code: true, name: true, nameAr: true, phone: true },
  });
  void likeTerm;
  return rows;
}
