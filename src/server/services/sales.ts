import "server-only";
import { Prisma, type SalesInvoiceStatus } from "@prisma/client";
import { msg } from "@/i18n/translator";
import { appointmentCode, phoneDigits } from "@/lib/constants";
import { DOC_PREFIX, formatDocNumber } from "@/lib/inventory";
import { SALES_PREFIX, SALES_STATUSES, cancelSaleSchema, saleSchema, type SaleInput } from "@/lib/sales";
import { prisma, type Tx } from "../db";
import { appointmentScope, assertCan, hasPermission } from "../access";
import type { CurrentUser } from "../auth/session";
import { NotFoundError, StaleRecordError, ValidationError } from "../errors";
import { recordAudit } from "./audit";
import { isUniqueViolation } from "./scheduling";
import { D, ZERO, canSeeCosts, checkId, dbDate, formError, keyOf, likeTerm, nextSequence, num, numOrNull, pageOf, parseInput, productParam, today } from "./inventory-common";
import { TX_OPTIONS, cancelInTx, mapStockDbError, postInTx } from "./inventory-posting";

/**
 * Sales invoices: the only record of what was sold. A draft is prepared, then confirmed; confirming
 * posts an ISSUE stock document for the invoice through the posting engine (stock is allocated
 * from the warehouse's locations, serials from where they are), and records the cost each line
 * left at. A confirmed sale is never edited: it is cancelled with a reason, which reverses its
 * stock document. Sales analytics read confirmed invoices only.
 */

const HALF_UP = Prisma.Decimal.ROUND_HALF_UP;
const money2 = (d: Prisma.Decimal) => d.toDecimalPlaces(2, HALF_UP);

export function canViewSales(user: CurrentUser) {
  return hasPermission(user, "sales.view") || hasPermission(user, "sales.manage");
}

type NormalLine = { lineNo: number; productId: string; quantity: Prisma.Decimal; unitPrice: Prisma.Decimal; discount: Prisma.Decimal; lineTotal: Prisma.Decimal; serials: string[] };

/** Exact totals in decimal arithmetic (the database checks the same rounding). */
function totalsOf(lines: NormalLine[]) {
  const total = lines.reduce((s, l) => s.plus(l.lineTotal), ZERO);
  const discountTotal = lines.reduce((s, l) => s.plus(l.discount), ZERO);
  return { subtotal: total.plus(discountTotal), discountTotal, total };
}

async function validateSale(tx: Tx, user: CurrentUser, input: SaleInput, now: Date) {
  const errors: Record<string, string> = {};
  if (input.invoiceDate > today(user, now)) errors.invoiceDate = msg("stock.errors.futureDate");
  // Selling is governed by sales.manage: a salesperson sells from any active warehouse (they do not
  // need the inventory pages for that).
  const w = await tx.warehouse.findUnique({ where: { id: input.warehouseId }, select: { id: true, isActive: true } });
  if (!w || !w.isActive) errors.warehouseId = msg("stock.errors.warehouse");
  let customer: { id: string; name: string; phone: string } | null = null;
  if (input.customerId) {
    customer = await tx.customer.findUnique({ where: { id: input.customerId }, select: { id: true, name: true, phone: true } });
    if (!customer) errors.customerId = msg("errors.notFound");
  }
  let appointmentId: string | null = null;
  if (input.appointmentRef) {
    const n = Number(input.appointmentRef.replace(/\D/g, ""));
    const a = n > 0 && n < 2_147_483_647 ? await tx.appointment.findFirst({ where: { AND: [{ number: n }, appointmentScope(user)] }, select: { id: true, customerId: true, customer: { select: { id: true, name: true, phone: true } } } }) : null;
    if (!a) errors.appointmentRef = msg("docLinks.visitNotFound");
    else {
      appointmentId = a.id;
      customer ??= a.customer;
    }
  }
  const products = await tx.product.findMany({
    where: { id: { in: [...new Set(input.lines.map((l) => l.productId))] } },
    select: { id: true, sku: true, nameEn: true, nameAr: true, isActive: true, hasVariants: true, trackSerials: true, serialsOptional: true, unit: { select: { allowsFraction: true, nameEn: true, nameAr: true } } },
  });
  const byId = new Map(products.map((p) => [p.id, p]));
  const lines: NormalLine[] = input.lines.map((l, i) => {
    const at = (f: string, m: string) => (errors[`lines.${i}.${f}`] ??= m);
    const p = byId.get(l.productId);
    if (!p || !p.isActive) at("productId", msg("stock.errors.product"));
    else if (p.hasVariants) at("productId", msg("variants.errors.pickVariant", productParam("product", p)));
    else {
      if (!p.unit.allowsFraction && !Number.isInteger(l.quantity)) at("quantity", msg("stock.errors.wholeUnits", { unit: p.unit.nameEn, unitAr: p.unit.nameAr }));
      if (p.trackSerials && l.serials.length !== l.quantity) at("serials", msg("stock.errors.serialCount", { count: l.quantity, given: l.serials.length }));
      if (p.serialsOptional && l.serials.length > l.quantity) at("serials", msg("serialModes.tooManySerials", { count: l.quantity, given: l.serials.length }));
      if (!p.trackSerials && !p.serialsOptional && l.serials.length) at("serials", msg("stock.errors.noSerials"));
    }
    const quantity = D(l.quantity);
    const unitPrice = D(l.unitPrice);
    const discount = D(l.discount);
    return { lineNo: i + 1, productId: l.productId, quantity, unitPrice, discount, lineTotal: money2(quantity.times(unitPrice).minus(discount)), serials: l.serials };
  });
  if (Object.keys(errors).length) throw new ValidationError(errors);
  const customerName = input.customerName ?? customer?.name ?? "";
  return { lines, header: { invoiceDate: dbDate(input.invoiceDate), customerId: customer?.id ?? null, customerName, customerPhone: input.customerPhone ?? customer?.phone ?? null, appointmentId, warehouseId: input.warehouseId, paymentMethod: input.paymentMethod, note: input.note } };
}

const lineData = (l: NormalLine) => ({ lineNo: l.lineNo, productId: l.productId, quantity: l.quantity, unitPrice: l.unitPrice, discount: l.discount, lineTotal: l.lineTotal, serials: l.serials });

async function lockSale(tx: Tx, id: string) {
  const found = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "sales_invoices" WHERE "id" = ${id} FOR UPDATE`;
  if (!found.length) throw new NotFoundError("sales.errors.notFound");
  return tx.salesInvoice.findUniqueOrThrow({ where: { id }, include: { lines: { orderBy: { lineNo: "asc" } } } });
}

/**
 * Confirms a draft inside the caller's transaction: allocates each line to the warehouse's
 * locations (stock without a bin first, then bins in code order; serials from where they are),
 * posts the ISSUE document, records the unit costs, and marks the invoice confirmed.
 */
async function confirmInTx(tx: Tx, user: CurrentUser, id: string, now: Date) {
  const inv = await lockSale(tx, id);
  if (inv.status === "CONFIRMED") return false;
  if (inv.status === "CANCELLED") throw formError("sales.errors.cancelled");
  assertCan(user, "sales.manage");
  const productIds = [...new Set(inv.lines.map((l) => l.productId))];
  const [balances, serialRows] = await Promise.all([
    tx.stockBalance.findMany({ where: { warehouseId: inv.warehouseId, productId: { in: productIds }, quantity: { gt: 0 } }, select: { productId: true, binId: true, binKey: true, quantity: true, bin: { select: { code: true } } } }),
    tx.productSerial.findMany({ where: { productId: { in: productIds }, serial: { in: inv.lines.flatMap((l) => l.serials) } }, select: { productId: true, serial: true, warehouseId: true, binId: true } }),
  ]);
  const free = new Map<string, { binId: string | null; code: string; qty: Prisma.Decimal }[]>();
  for (const b of balances.sort((a, c) => (a.binKey === "" ? -1 : c.binKey === "" ? 1 : (a.bin?.code ?? "").localeCompare(c.bin?.code ?? "")))) {
    free.set(b.productId, [...(free.get(b.productId) ?? []), { binId: b.binId, code: b.bin?.code ?? "", qty: D(b.quantity) }]);
  }
  const serialAt = new Map(serialRows.map((s) => [`${s.productId}|${s.serial}`, s]));
  // One document line per location a sale line takes stock from.
  const docLines: { saleLineNo: number; productId: string; quantity: Prisma.Decimal; fromBinId: string | null; serials: string[] }[] = [];
  for (const l of inv.lines) {
    let left = D(l.quantity);
    const take = (binId: string | null, qty: Prisma.Decimal, serials: string[]) => {
      docLines.push({ saleLineNo: l.lineNo, productId: l.productId, quantity: qty, fromBinId: binId, serials });
      const loc = (free.get(l.productId) ?? []).find((x) => x.binId === binId);
      if (loc) loc.qty = loc.qty.minus(qty);
      left = left.minus(qty);
    };
    // Named serials leave from where each one is.
    const bySerialBin = new Map<string, string[]>();
    for (const s of l.serials) {
      const at = serialAt.get(`${l.productId}|${s}`);
      const key = at?.warehouseId === inv.warehouseId ? (at.binId ?? "") : "";
      bySerialBin.set(key, [...(bySerialBin.get(key) ?? []), s]);
    }
    for (const [binKey, serials] of bySerialBin) take(binKey || null, D(serials.length), serials);
    // The rest from the locations with stock; whatever is left is asked of the warehouse itself,
    // so the posting engine names the shortage.
    for (const loc of free.get(l.productId) ?? []) {
      if (!left.greaterThan(0)) break;
      const q = Prisma.Decimal.min(left, loc.qty);
      if (q.greaterThan(0)) take(loc.binId, q, []);
    }
    if (left.greaterThan(0)) take(null, left, []);
  }
  // Lines on the same product and location are merged (the engine wants one per location).
  const merged = new Map<string, (typeof docLines)[number]>();
  for (const d of docLines) {
    const k = `${d.saleLineNo}|${d.productId}|${d.fromBinId ?? ""}`;
    const m = merged.get(k);
    if (m) {
      m.quantity = m.quantity.plus(d.quantity);
      m.serials.push(...d.serials);
    } else merged.set(k, { ...d, serials: [...d.serials] });
  }
  const dateKey = keyOf(inv.invoiceDate);
  const year = Number(dateKey.slice(0, 4));
  const number = formatDocNumber(DOC_PREFIX.ISSUE, year, await nextSequence(tx, `${DOC_PREFIX.ISSUE}-${year}`));
  const doc = await tx.stockDocument.create({
    data: {
      number,
      type: "ISSUE",
      fromWarehouseId: inv.warehouseId,
      documentDate: inv.invoiceDate,
      reference: inv.number,
      counterparty: inv.customerName,
      appointmentId: inv.appointmentId,
      createdById: user.id,
      createdAt: now,
      lines: { create: [...merged.values()].map((d, i) => ({ lineNo: i + 1, productId: d.productId, quantity: d.quantity, fromBinId: d.fromBinId, serials: d.serials, reason: inv.number })) },
    },
    include: { lines: true },
  });
  try {
    await postInTx(tx, user, doc.id, { now, onBehalfOf: "sale" });
  } catch (e) {
    if (e instanceof ValidationError) {
      // Report the shortage on the sale's own lines.
      const docLineToSale = new Map(doc.lines.map((dl, i) => [dl.lineNo, [...merged.values()][i]!.saleLineNo]));
      const fieldErrors: Record<string, string> = { _form: e.rawFieldErrors._form ?? e.raw };
      for (const [k, v] of Object.entries(e.rawFieldErrors)) {
        const m = /^lines\.(\d+)\.(\w+)$/.exec(k);
        if (m) fieldErrors[`lines.${docLineToSale.get(Number(m[1]) + 1)! - 1}.${m[2] === "serials" ? "serials" : "quantity"}`] ??= v;
      }
      throw new ValidationError(fieldErrors, e.raw);
    }
    throw e;
  }
  // The cost each line left at (weighted over its locations).
  const movements = await tx.inventoryMovement.findMany({ where: { documentId: doc.id }, select: { lineId: true, quantity: true, unitCost: true } });
  const lineNoOf = new Map(doc.lines.map((dl) => [dl.id, dl.lineNo]));
  const docToSale = new Map([...merged.values()].map((d, i) => [i + 1, d.saleLineNo]));
  const cost = new Map<number, { qty: Prisma.Decimal; value: Prisma.Decimal }>();
  for (const m of movements) {
    const saleLine = docToSale.get(lineNoOf.get(m.lineId)!)!;
    const c = cost.get(saleLine) ?? { qty: ZERO, value: ZERO };
    const q = D(m.quantity).abs();
    cost.set(saleLine, { qty: c.qty.plus(q), value: c.value.plus(q.times(m.unitCost)) });
  }
  for (const l of inv.lines) {
    const c = cost.get(l.lineNo);
    if (c && c.qty.greaterThan(0)) await tx.salesInvoiceLine.update({ where: { id: l.id }, data: { unitCost: c.value.dividedBy(c.qty).toDecimalPlaces(4) } });
  }
  await tx.salesInvoice.update({ where: { id: inv.id }, data: { status: "CONFIRMED", stockDocumentId: doc.id, confirmedAt: now, confirmedById: user.id, version: { increment: 1 } } });
  await recordAudit(tx, {
    entityType: "SALE",
    entityId: inv.id,
    action: "SALE_CONFIRMED",
    summary: msg("erpAudit.saleConfirmed", { name: user.name, number: inv.number, document: number }),
    changes: { number: inv.number, total: num(inv.total), stockDocument: number },
    actorId: user.id,
    appointmentId: inv.appointmentId,
  });
  return true;
}

export async function createSale(user: CurrentUser, raw: unknown, opts: { confirm?: boolean; now?: Date } = {}): Promise<{ id: string; number: string }> {
  assertCan(user, "sales.manage");
  const input = parseInput(saleSchema, raw);
  const now = opts.now ?? new Date();
  if (input.clientRequestId) {
    const existing = await prisma.salesInvoice.findUnique({ where: { clientRequestId: input.clientRequestId }, select: { id: true, number: true, createdById: true } });
    if (existing) {
      if (existing.createdById !== user.id) throw formError("stock.errors.duplicateRequest");
      return { id: existing.id, number: existing.number };
    }
  }
  try {
    return await prisma.$transaction(async (tx) => {
      const { lines, header } = await validateSale(tx, user, input, now);
      const year = Number(input.invoiceDate.slice(0, 4));
      const number = formatDocNumber(SALES_PREFIX, year, await nextSequence(tx, `${SALES_PREFIX}-${year}`));
      const inv = await tx.salesInvoice.create({ data: { ...header, ...totalsOf(lines), number, clientRequestId: input.clientRequestId ?? null, createdById: user.id, createdAt: now, lines: { create: lines.map(lineData) } } });
      await recordAudit(tx, {
        entityType: "SALE",
        entityId: inv.id,
        action: "SALE_CREATED",
        summary: msg("erpAudit.saleCreated", { name: user.name, number, customer: header.customerName }),
        changes: { number, lines: lines.length, total: num(inv.total) },
        actorId: user.id,
        appointmentId: header.appointmentId,
      });
      if (opts.confirm) await confirmInTx(tx, user, inv.id, now);
      return { id: inv.id, number };
    }, TX_OPTIONS);
  } catch (e) {
    if (input.clientRequestId && isUniqueViolation(e, "clientRequestId")) {
      const existing = await prisma.salesInvoice.findUnique({ where: { clientRequestId: input.clientRequestId }, select: { id: true, number: true, createdById: true } });
      if (existing && existing.createdById === user.id) return { id: existing.id, number: existing.number };
    }
    throw mapStockDbError(e);
  }
}

export async function updateSale(user: CurrentUser, id: string, raw: unknown, opts: { confirm?: boolean; now?: Date } = {}): Promise<{ id: string; number: string }> {
  assertCan(user, "sales.manage");
  const input = parseInput(saleSchema, raw);
  const now = opts.now ?? new Date();
  try {
    return await prisma.$transaction(async (tx) => {
      const inv = await lockSale(tx, checkId(id));
      if (inv.status !== "DRAFT") throw formError("sales.errors.notDraft");
      if (input.version !== undefined && input.version !== inv.version) throw new StaleRecordError();
      const { lines, header } = await validateSale(tx, user, input, now);
      await tx.salesInvoiceLine.deleteMany({ where: { invoiceId: inv.id } });
      await tx.salesInvoice.update({ where: { id: inv.id }, data: { ...header, ...totalsOf(lines), version: { increment: 1 }, lines: { create: lines.map(lineData) } } });
      await recordAudit(tx, {
        entityType: "SALE",
        entityId: inv.id,
        action: "SALE_UPDATED",
        summary: msg("erpAudit.saleUpdated", { name: user.name, number: inv.number }),
        changes: { lines: lines.length, total: { from: num(inv.total), to: num(totalsOf(lines).total) } },
        actorId: user.id,
        appointmentId: header.appointmentId,
      });
      if (opts.confirm) await confirmInTx(tx, user, inv.id, now);
      return { id: inv.id, number: inv.number };
    }, TX_OPTIONS);
  } catch (e) {
    throw mapStockDbError(e);
  }
}

export async function confirmSale(user: CurrentUser, id: string, now = new Date()) {
  assertCan(user, "sales.manage");
  try {
    await prisma.$transaction((tx) => confirmInTx(tx, user, checkId(id), now), TX_OPTIONS);
  } catch (e) {
    throw mapStockDbError(e);
  }
  return getSale(user, id);
}

/**
 * Cancels a sale. A draft is simply closed; a confirmed sale needs `sales.void` and a reason, and
 * its stock document is reversed (the stock comes back where it left). Cancelling twice is a no-op.
 */
export async function cancelSale(user: CurrentUser, id: string, raw: unknown, now = new Date()) {
  const { reason, version } = parseInput(cancelSaleSchema, raw);
  try {
    await prisma.$transaction(async (tx) => {
      const inv = await lockSale(tx, checkId(id));
      if (inv.status === "CANCELLED") return;
      if (version !== undefined && version !== inv.version) throw new StaleRecordError();
      if (inv.status === "DRAFT") assertCan(user, "sales.manage");
      else {
        assertCan(user, "sales.void");
        if (!reason) throw new ValidationError({ reason: msg("stock.errors.cancelReason") }, msg("stock.errors.cancelReason"));
        // Stored as plain text on the stock document (its page shows it as written).
        await cancelInTx(tx, user, inv.stockDocumentId!, `${inv.number}: ${reason}`, now, { onBehalfOf: "sale" });
      }
      await tx.salesInvoice.update({ where: { id: inv.id }, data: { status: "CANCELLED", cancelledAt: now, cancelledById: user.id, cancelReason: reason, version: { increment: 1 } } });
      await recordAudit(tx, {
        entityType: "SALE",
        entityId: inv.id,
        action: inv.status === "DRAFT" ? "SALE_DRAFT_CANCELLED" : "SALE_CANCELLED",
        summary: msg(inv.status === "DRAFT" ? "erpAudit.saleDraftCancelled" : "erpAudit.saleCancelled", { name: user.name, number: inv.number, reason: reason ?? "" }),
        changes: { reason },
        actorId: user.id,
        appointmentId: inv.appointmentId,
      });
    }, TX_OPTIONS);
  } catch (e) {
    throw mapStockDbError(e);
  }
  return getSale(user, id);
}

/** Active warehouses to sell from (the sale form). */
export async function saleWarehouses(user: CurrentUser) {
  assertCan(user, "sales.manage");
  return prisma.warehouse.findMany({ where: { isActive: true }, orderBy: [{ kind: "asc" }, { code: "asc" }], select: { id: true, code: true, nameEn: true, nameAr: true, kind: true } });
}

export type SalesFilters = { q?: string; status?: string; from?: string; to?: string; page?: number; pageSize?: number };

export async function listSales(user: CurrentUser, f: SalesFilters = {}) {
  if (!canViewSales(user)) throw new NotFoundError();
  const pageSize = Math.min(100, Math.max(5, f.pageSize ?? 25));
  const { page, skip, take } = pageOf(f.page, pageSize);
  const and: Prisma.SalesInvoiceWhereInput[] = [];
  if (f.status && (SALES_STATUSES as string[]).includes(f.status)) and.push({ status: f.status as SalesInvoiceStatus });
  if (f.from && /^\d{4}-\d{2}-\d{2}$/.test(f.from)) and.push({ invoiceDate: { gte: dbDate(f.from) } });
  if (f.to && /^\d{4}-\d{2}-\d{2}$/.test(f.to)) and.push({ invoiceDate: { lte: dbDate(f.to) } });
  const q = f.q?.trim().slice(0, 100);
  if (q) {
    const digits = phoneDigits(q);
    and.push({ OR: [{ number: { contains: q.toUpperCase() } }, { customerName: { contains: q, mode: "insensitive" } }, ...(digits.length >= 4 ? [{ customerPhone: { contains: digits } }] : [])] });
  }
  const where = and.length ? { AND: and } : {};
  const [total, rows, sums] = await Promise.all([
    prisma.salesInvoice.count({ where }),
    prisma.salesInvoice.findMany({
      where,
      orderBy: [{ invoiceDate: "desc" }, { createdAt: "desc" }],
      skip,
      take,
      select: { id: true, number: true, status: true, invoiceDate: true, customerName: true, total: true, warehouse: { select: { code: true } }, createdBy: { select: { name: true } }, _count: { select: { lines: true } } },
    }),
    prisma.salesInvoice.aggregate({ where: { AND: [where, { status: "CONFIRMED" }] }, _sum: { total: true }, _count: { _all: true } }),
  ]);
  void likeTerm;
  return {
    total,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
    confirmedTotal: num(sums._sum.total),
    confirmedCount: sums._count._all,
    rows: rows.map((r) => ({ ...r, invoiceDate: keyOf(r.invoiceDate), total: num(r.total), lines: r._count.lines })),
  };
}

export async function getSale(user: CurrentUser, id: string) {
  if (!canViewSales(user)) throw new NotFoundError();
  const inv = await prisma.salesInvoice.findUnique({
    where: { id: checkId(id) },
    include: {
      warehouse: { select: { id: true, code: true, nameEn: true, nameAr: true } },
      customer: { select: { id: true, name: true } },
      appointment: { select: { id: true, number: true } },
      stockDocument: { select: { id: true, number: true, status: true } },
      createdBy: { select: { id: true, name: true } },
      confirmedBy: { select: { id: true, name: true } },
      cancelledBy: { select: { id: true, name: true } },
      lines: {
        orderBy: { lineNo: "asc" },
        include: { product: { select: { id: true, sku: true, nameEn: true, nameAr: true, trackSerials: true, serialsOptional: true, unit: { select: { code: true, allowsFraction: true } } } } },
      },
    },
  });
  if (!inv) throw new NotFoundError("sales.errors.notFound");
  const costs = canSeeCosts(user);
  return {
    id: inv.id,
    number: inv.number,
    status: inv.status,
    version: inv.version,
    invoiceDate: keyOf(inv.invoiceDate),
    customer: inv.customer,
    customerName: inv.customerName,
    customerPhone: hasPermission(user, "customers.contact") || hasPermission(user, "sales.manage") ? inv.customerPhone : null,
    appointment: inv.appointment ? { id: inv.appointment.id, code: appointmentCode(inv.appointment.number) } : null,
    warehouse: inv.warehouse,
    paymentMethod: inv.paymentMethod,
    note: inv.note,
    subtotal: num(inv.subtotal),
    discountTotal: num(inv.discountTotal),
    total: num(inv.total),
    stockDocument: hasPermission(user, "inventory.view") ? inv.stockDocument : null,
    createdBy: inv.createdBy,
    createdAt: inv.createdAt.toISOString(),
    confirmedBy: inv.confirmedBy,
    confirmedAt: inv.confirmedAt?.toISOString() ?? null,
    cancelledBy: inv.cancelledBy,
    cancelledAt: inv.cancelledAt?.toISOString() ?? null,
    cancelReason: inv.cancelReason,
    lines: inv.lines.map((l) => ({
      id: l.id,
      lineNo: l.lineNo,
      product: l.product,
      quantity: num(l.quantity),
      unitPrice: num(l.unitPrice),
      discount: num(l.discount),
      lineTotal: num(l.lineTotal),
      unitCost: costs ? numOrNull(l.unitCost) : null,
      serials: l.serials,
    })),
    can: {
      edit: inv.status === "DRAFT" && hasPermission(user, "sales.manage"),
      confirm: inv.status === "DRAFT" && hasPermission(user, "sales.manage"),
      cancelDraft: inv.status === "DRAFT" && hasPermission(user, "sales.manage"),
      void: inv.status === "CONFIRMED" && hasPermission(user, "sales.void"),
      seeCosts: costs,
    },
  };
}
export type SaleDetail = Awaited<ReturnType<typeof getSale>>;
