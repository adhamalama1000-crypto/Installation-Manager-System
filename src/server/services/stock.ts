import "server-only";
import { Prisma, type ProductCategory, type StockStatus } from "@prisma/client";
import { STOCK_STATUSES, STOCK_STATUS_LABELS, appointmentCode, normalizeSerial, parseAppointmentCode } from "@/lib/constants";
import { addMonthsKeepDay, dateKey } from "@/lib/time";
import { fieldErrorsFromZod, productModelSchema, stockInSchema, stockMoveSchema } from "@/lib/validation";
import { prisma, type Tx } from "../db";
import { assertCan, hasPermission } from "../access";
import type { CurrentUser } from "../auth/session";
import { NotFoundError, ValidationError } from "../errors";
import { recordAudit } from "./audit";
import { notifyUsers } from "./notifications";
import { isUniqueViolation } from "./scheduling";

/**
 * Serial-numbered stock (Aura: المخزن). The store registers goods in, hands items to technicians
 * (custody), takes them back or marks them returned / faulty; a technician installs items from
 * their own custody when finishing a visit, which starts the warranty. Every change is written to
 * the append-only stock_movements table.
 */

const TX_OPTIONS = { timeout: 20_000, maxWait: 10_000 };
const PAGE_SIZE = 50;

const itemSelect = {
  id: true,
  serial: true,
  status: true,
  note: true,
  installedAt: true,
  warrantyUntil: true,
  updatedAt: true,
  model: { select: { id: true, name: true, category: true } },
  holder: { select: { id: true, name: true } },
  appointment: { select: { id: true, number: true } },
} satisfies Prisma.StockItemSelect;

type ItemRow = Prisma.StockItemGetPayload<{ select: typeof itemSelect }>;

export type StockItemDTO = {
  id: string;
  serial: string;
  status: StockStatus;
  model: { id: string; name: string; category: ProductCategory };
  holder: { id: string; name: string } | null;
  appointment: { id: string; code: string } | null;
  installedAt: string | null;
  warrantyUntil: string | null;
  note: string | null;
  updatedAt: string;
};

const keyOf = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

function toItemDTO(i: ItemRow): StockItemDTO {
  return {
    id: i.id,
    serial: i.serial,
    status: i.status,
    model: i.model,
    holder: i.holder,
    appointment: i.appointment ? { id: i.appointment.id, code: appointmentCode(i.appointment.number) } : null,
    installedAt: i.installedAt?.toISOString() ?? null,
    warrantyUntil: keyOf(i.warrantyUntil),
    note: i.note,
    updatedAt: i.updatedAt.toISOString(),
  };
}

/** Technicians only see what they hold; the store, Admins and the accountant see everything. */
function ownStockOnly(user: CurrentUser) {
  return user.role === "TECHNICIAN" && !hasPermission(user, "stock.manage");
}

// ---------------------------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------------------------

export async function listModels(user: CurrentUser) {
  assertCan(user, "stock.view");
  const models = await prisma.productModel.findMany({ orderBy: [{ isActive: "desc" }, { name: "asc" }] });
  return models.map((m) => ({ id: m.id, name: m.name, category: m.category, warrantyMonths: m.warrantyMonths, isActive: m.isActive }));
}

export async function saveModel(user: CurrentUser, id: string | null, raw: unknown) {
  assertCan(user, "stock.manage");
  const parsed = productModelSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(fieldErrorsFromZod(parsed.error));
  const input = parsed.data;
  return prisma.$transaction(async (tx) => {
    // Names are unique regardless of case; the lock makes the check safe against a double submit.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('stock:models', 0))`;
    const clash = await tx.productModel.findFirst({ where: { name: { equals: input.name, mode: "insensitive" }, ...(id ? { id: { not: id } } : {}) } });
    if (clash) throw new ValidationError({ name: `A model called "${clash.name}" already exists.` });
    const data = { name: input.name, category: input.category as ProductCategory, warrantyMonths: input.warrantyMonths, ...(input.isActive !== undefined ? { isActive: input.isActive } : {}) };
    const before = id ? await tx.productModel.findUnique({ where: { id } }) : null;
    if (id && !before) throw new NotFoundError("Model not found.");
    const model = id ? await tx.productModel.update({ where: { id }, data }) : await tx.productModel.create({ data });
    await recordAudit(tx, {
      entityType: "STOCK",
      entityId: model.id,
      action: id ? "MODEL_UPDATED" : "MODEL_CREATED",
      summary: `${id ? "Updated" : "Added"} product model ${model.name} (${model.warrantyMonths} months warranty)`,
      changes: before
        ? { name: { from: before.name, to: model.name }, warrantyMonths: { from: before.warrantyMonths, to: model.warrantyMonths }, isActive: { from: before.isActive, to: model.isActive } }
        : { name: model.name, category: model.category, warrantyMonths: model.warrantyMonths },
      actorId: user.id,
    });
    return { id: model.id };
  });
}

// ---------------------------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------------------------

export type StockFilters = { q?: string; status?: string; modelId?: string; holderId?: string; page?: number };

export async function stockOverview(user: CurrentUser, f: StockFilters) {
  assertCan(user, "stock.view");
  const own = ownStockOnly(user);
  const and: Prisma.StockItemWhereInput[] = [];
  if (own) and.push({ holderId: user.id, status: "WITH_TECHNICIAN" });
  if (f.status && (STOCK_STATUSES as string[]).includes(f.status)) and.push({ status: f.status as StockStatus });
  if (f.modelId) and.push({ modelId: f.modelId });
  if (f.holderId && !own) and.push({ holderId: f.holderId });
  const q = f.q?.trim();
  if (q) {
    const num = parseAppointmentCode(q);
    and.push({ OR: [{ serial: { contains: normalizeSerial(q) } }, ...(num ? [{ appointment: { number: num } }] : [])] });
  }
  const where: Prisma.StockItemWhereInput = { AND: and };
  const page = Math.max(1, Math.min(f.page ?? 1, 10_000));
  const [items, total, summary] = await Promise.all([
    prisma.stockItem.findMany({ where, select: itemSelect, orderBy: [{ updatedAt: "desc" }, { id: "asc" }], skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE }),
    prisma.stockItem.count({ where }),
    own
      ? Promise.resolve([])
      : prisma.$queryRaw<{ modelId: string; name: string; status: StockStatus; n: number }[]>`
          SELECT i."modelId", m.name, i.status, count(*)::int AS n
          FROM stock_items i JOIN product_models m ON m.id = i."modelId"
          GROUP BY i."modelId", m.name, i.status
          ORDER BY m.name`,
  ]);
  // One row per model with a count per status.
  const byModel = new Map<string, { modelId: string; name: string; counts: Partial<Record<StockStatus, number>> }>();
  for (const r of summary) {
    const row = byModel.get(r.modelId) ?? { modelId: r.modelId, name: r.name, counts: {} };
    row.counts[r.status] = r.n;
    byModel.set(r.modelId, row);
  }
  return {
    items: items.map(toItemDTO),
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    summary: [...byModel.values()],
    own,
    canManage: hasPermission(user, "stock.manage"),
  };
}

export async function itemHistory(user: CurrentUser, serial: string) {
  assertCan(user, "stock.view");
  const item = await prisma.stockItem.findUnique({ where: { serial: normalizeSerial(serial) }, select: { ...itemSelect, holderId: true } });
  if (!item || (ownStockOnly(user) && item.holderId !== user.id)) throw new NotFoundError("Serial number not found.");
  const moves = await prisma.stockMovement.findMany({
    where: { itemId: item.id },
    select: {
      id: true,
      fromStatus: true,
      toStatus: true,
      note: true,
      createdAt: true,
      actor: { select: { name: true } },
      holder: { select: { name: true } },
      appointment: { select: { id: true, number: true } },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 100,
  });
  return {
    item: toItemDTO(item),
    movements: moves.map((m) => ({
      id: m.id,
      fromStatus: m.fromStatus,
      toStatus: m.toStatus,
      note: m.note,
      createdAt: m.createdAt.toISOString(),
      actor: m.actor.name,
      holder: m.holder?.name ?? null,
      appointment: m.appointment ? { id: m.appointment.id, code: appointmentCode(m.appointment.number) } : null,
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// Goods in and moves
// ---------------------------------------------------------------------------------------------

export async function stockIn(user: CurrentUser, raw: unknown) {
  assertCan(user, "stock.manage");
  const parsed = stockInSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(fieldErrorsFromZod(parsed.error));
  const { modelId, serials, note } = parsed.data;
  try {
    return await prisma.$transaction(async (tx) => {
      const model = await tx.productModel.findUnique({ where: { id: modelId } });
      if (!model || !model.isActive) throw new ValidationError({ modelId: "Choose an active model." });
      const existing = await tx.stockItem.findMany({ where: { serial: { in: serials } }, select: { serial: true } });
      if (existing.length) {
        const msg = `Already registered: ${existing.map((e) => e.serial).join(", ")}`;
        throw new ValidationError({ serials: msg }, msg);
      }
      await tx.stockItem.createMany({ data: serials.map((serial) => ({ serial, modelId, note, createdById: user.id })) });
      const created = await tx.stockItem.findMany({ where: { serial: { in: serials } }, select: { id: true } });
      await tx.stockMovement.createMany({ data: created.map((c) => ({ itemId: c.id, toStatus: "IN_STORE" as const, note: note ?? "Goods in", actorId: user.id })) });
      await recordAudit(tx, {
        entityType: "STOCK",
        entityId: model.id,
        action: "STOCK_IN",
        summary: `Goods in: ${serials.length} × ${model.name}`,
        changes: { model: model.name, serials },
        actorId: user.id,
      });
      return { count: serials.length };
    }, TX_OPTIONS);
  } catch (e) {
    // Two people registering the same serial at the same moment.
    if (isUniqueViolation(e, "serial")) throw new ValidationError({ serials: "One of these serial numbers was just registered by someone else." });
    throw e;
  }
}

const MOVE_VERB: Record<"IN_STORE" | "WITH_TECHNICIAN" | "RETURNED" | "FAULTY", string> = {
  IN_STORE: "Back in store",
  WITH_TECHNICIAN: "Handed to",
  RETURNED: "Marked returned",
  FAULTY: "Marked faulty",
};

/** Hands items to a technician, takes them back, or marks them returned / faulty. */
export async function moveStock(user: CurrentUser, raw: unknown) {
  assertCan(user, "stock.manage");
  const parsed = stockMoveSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(fieldErrorsFromZod(parsed.error));
  const { itemIds, to, technicianId, note } = parsed.data;
  return prisma.$transaction(async (tx) => {
    let holder: { id: string; name: string } | null = null;
    if (to === "WITH_TECHNICIAN") {
      const t = await tx.user.findUnique({ where: { id: technicianId! }, select: { id: true, name: true, role: true, isActive: true } });
      if (!t || t.role !== "TECHNICIAN" || !t.isActive) throw new ValidationError({ technicianId: "Choose an active technician." });
      holder = { id: t.id, name: t.name };
    }
    const ids = [...new Set(itemIds)];
    const rows = await tx.$queryRaw<{ id: string; serial: string; status: StockStatus; holderId: string | null; appointmentId: string | null }[]>`
      SELECT id, serial, status, "holderId", "appointmentId" FROM stock_items WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`;
    if (rows.length !== ids.length) throw new NotFoundError("Some of these items no longer exist. Refresh the page.");
    // An installed item only leaves its installation as returned or faulty (e.g. a warranty swap).
    const stuck = rows.filter((r) => r.status === "INSTALLED" && to !== "RETURNED" && to !== "FAULTY");
    if (stuck.length) {
      const msg = `${stuck.map((r) => r.serial).join(", ")} ${stuck.length === 1 ? "is" : "are"} installed; mark ${stuck.length === 1 ? "it" : "them"} returned or faulty instead.`;
      throw new ValidationError({ _form: msg }, msg);
    }
    const moving = rows.filter((r) => !(r.status === to && r.holderId === (holder?.id ?? null)));
    if (!moving.length) return { count: 0 };
    await tx.stockItem.updateMany({
      where: { id: { in: moving.map((r) => r.id) } },
      data: { status: to, holderId: holder?.id ?? null, appointmentId: null, installedAt: null, warrantyUntil: null, ...(note ? { note } : {}) },
    });
    await tx.stockMovement.createMany({
      data: moving.map((r) => ({
        itemId: r.id,
        fromStatus: r.status,
        toStatus: to,
        holderId: holder?.id ?? null,
        // Leaving an installation keeps the link in the history.
        appointmentId: r.appointmentId,
        note,
        actorId: user.id,
      })),
    });
    const serials = moving.map((r) => r.serial);
    await recordAudit(tx, {
      entityType: "STOCK",
      entityId: holder?.id ?? moving[0]!.id,
      action: "STOCK_MOVED",
      summary: `${MOVE_VERB[to]}${holder ? ` ${holder.name}` : ""}: ${serials.length} item${serials.length === 1 ? "" : "s"}${note ? ` (${note})` : ""}`,
      changes: { to: STOCK_STATUS_LABELS[to], ...(holder ? { technician: holder.name } : {}), serials },
      actorId: user.id,
    });
    if (holder) {
      await notifyUsers(tx, [holder.id], { type: "STOCK_HANDED", message: `${user.name} handed you ${serials.length} item${serials.length === 1 ? "" : "s"}: ${serials.slice(0, 10).join(", ")}${serials.length > 10 ? " …" : ""}` }, user.id);
    }
    const back = moving.filter((r) => r.holderId && r.holderId !== holder?.id);
    for (const prev of [...new Set(back.map((r) => r.holderId!))]) {
      const theirs = back.filter((r) => r.holderId === prev).map((r) => r.serial);
      await notifyUsers(tx, [prev], { type: "STOCK_TAKEN", message: `${user.name} took back ${theirs.length} item${theirs.length === 1 ? "" : "s"} from your custody: ${theirs.slice(0, 10).join(", ")}` }, user.id);
    }
    return { count: moving.length };
  }, TX_OPTIONS);
}

// ---------------------------------------------------------------------------------------------
// Installation at the visit
// ---------------------------------------------------------------------------------------------

/**
 * Marks the given serials installed on the appointment (from the visit outcome). A technician can
 * only install items from their own custody; whoever manages the booking or the store may also
 * take items straight from the store. Warranty runs from the visit date for the model's months.
 */
export async function installSerials(tx: Tx, user: CurrentUser, appt: { id: string; startsAt: Date }, serials: string[], tz: string, now: Date): Promise<string[]> {
  if (!serials.length) return [];
  const rows = await tx.$queryRaw<{ id: string; serial: string; status: StockStatus; holderId: string | null; appointmentId: string | null; number: number | null; holderName: string | null; warrantyMonths: number }[]>`
    SELECT i.id, i.serial, i.status, i."holderId", i."appointmentId", a.number, h.name AS "holderName", m."warrantyMonths"
    FROM stock_items i
    JOIN product_models m ON m.id = i."modelId"
    LEFT JOIN appointments a ON a.id = i."appointmentId"
    LEFT JOIN users h ON h.id = i."holderId"
    WHERE i.serial IN (${Prisma.join(serials)})
    ORDER BY i.id
    FOR UPDATE OF i`;
  const problems: string[] = [];
  const missing = serials.filter((s) => !rows.some((r) => r.serial === s));
  if (missing.length) problems.push(`Not in stock: ${missing.join(", ")} - the store has to register ${missing.length === 1 ? "it" : "them"} first.`);
  const fromStore = hasPermission(user, "appointments.manage") || hasPermission(user, "stock.manage");
  const todo = [];
  for (const r of rows) {
    if (r.status === "INSTALLED") {
      if (r.appointmentId !== appt.id) problems.push(`${r.serial} is already installed on ${appointmentCode(r.number!)}.`);
      continue;
    }
    if (r.status === "FAULTY" || r.status === "RETURNED") {
      problems.push(`${r.serial} is marked ${STOCK_STATUS_LABELS[r.status].toLowerCase()} - talk to the store.`);
      continue;
    }
    const mine = r.status === "WITH_TECHNICIAN" && r.holderId === user.id;
    if (!mine && !fromStore) {
      problems.push(`${r.serial} is not in your custody (${r.holderName ? `with ${r.holderName}` : "in the store"}).`);
      continue;
    }
    todo.push(r);
  }
  if (problems.length) throw new ValidationError({ serials: problems.join(" ") }, problems[0]);
  const visitDay = dateKey(appt.startsAt, tz);
  for (const r of todo) {
    await tx.stockItem.update({
      where: { id: r.id },
      data: {
        status: "INSTALLED",
        holderId: null,
        appointmentId: appt.id,
        installedAt: now,
        warrantyUntil: new Date(`${addMonthsKeepDay(visitDay, r.warrantyMonths)}T00:00:00.000Z`),
      },
    });
  }
  if (todo.length) {
    await tx.stockMovement.createMany({
      data: todo.map((r) => ({ itemId: r.id, fromStatus: r.status, toStatus: "INSTALLED" as const, appointmentId: appt.id, actorId: user.id })),
    });
  }
  return todo.map((r) => r.serial);
}

/** Items installed on a visit with their warranty, for the appointment page. */
export async function installedOn(appointmentId: string) {
  const rows = await prisma.stockItem.findMany({
    where: { appointmentId },
    select: { serial: true, warrantyUntil: true, model: { select: { name: true } } },
    orderBy: { serial: "asc" },
  });
  return rows.map((r) => ({ serial: r.serial, model: r.model.name, warrantyUntil: keyOf(r.warrantyUntil) }));
}

/** Items a technician holds, offered as quick picks when they record the outcome. */
export async function heldBy(technicianId: string) {
  const rows = await prisma.stockItem.findMany({
    where: { holderId: technicianId, status: "WITH_TECHNICIAN" },
    select: { serial: true, model: { select: { name: true } } },
    orderBy: [{ model: { name: "asc" } }, { serial: "asc" }],
    take: 200,
  });
  return rows.map((r) => ({ serial: r.serial, model: r.model.name }));
}
