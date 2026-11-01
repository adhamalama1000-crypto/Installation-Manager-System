import "server-only";
import { z } from "zod";
import { Prisma, type ExpenseStatus } from "@prisma/client";
import { msg } from "@/i18n/translator";
import { appointmentCode } from "@/lib/constants";
import { addDaysToKey, addMonthsToKey, dayRangeUtc, startOfMonthKey, todayKey } from "@/lib/time";
import { fieldErrorsFromZod, optionalText } from "@/lib/validation";
import { prisma } from "../db";
import { appointmentScope, assertCan, hasPermission } from "../access";
import type { CurrentUser } from "../auth/session";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { moneyParam } from "../i18n-params";
import { detectImageType, discardFile, readStoredFile, saveFile } from "../storage";
import { recordAudit } from "./audit";
import { notifyUsers } from "./notifications";

/**
 * Transport expenses (Aura DB_Expenses): a technician or the driver records what they paid to get
 * to a visit, with a photo of the receipt; the accountant pays each person's pending expenses for
 * a month in one go. Amounts never change once recorded and rows are never deleted (trigger); the
 * owner can cancel an expense recorded by mistake until it is paid.
 */

const dbDate = (key: string) => new Date(`${key}T00:00:00.000Z`);
const keyOf = (d: Date) => d.toISOString().slice(0, 10);

const amountField = z.preprocess(
  (v) => (typeof v === "string" ? Number(v.replace(/[,\s]/g, "")) : v),
  z.number({ error: msg("expenses.errors.amount") }).positive(msg("expenses.errors.amount")).max(100_000, msg("expenses.errors.amount")),
);
const addSchema = z.object({ amount: amountField, appointmentId: z.string().max(64).optional().nullable(), note: optionalText(300) });

export type ExpenseDTO = {
  id: string;
  user: { id: string; name: string };
  day: string;
  amount: number;
  note: string | null;
  appointment: { id: string; code: string; customerName: string } | null;
  hasReceipt: boolean;
  status: ExpenseStatus;
  paidAt: string | null;
  paidBy: { id: string; name: string } | null;
  canCancel: boolean;
  canAddReceipt: boolean;
};

const include = {
  user: { select: { id: true, name: true } },
  paidBy: { select: { id: true, name: true } },
  appointment: { select: { id: true, number: true, customer: { select: { name: true } } } },
} satisfies Prisma.TransportExpenseInclude;
type Row = Prisma.TransportExpenseGetPayload<{ include: typeof include }>;

function toDTO(user: CurrentUser, e: Row): ExpenseDTO {
  const own = e.userId === user.id;
  return {
    id: e.id,
    user: e.user,
    day: keyOf(e.day),
    amount: e.amount.toNumber(),
    note: e.note,
    appointment: e.appointment ? { id: e.appointment.id, code: appointmentCode(e.appointment.number), customerName: e.appointment.customer.name } : null,
    hasReceipt: e.receiptKey !== null,
    status: e.status,
    paidAt: e.paidAt?.toISOString() ?? null,
    paidBy: e.paidBy,
    canCancel: own && e.status === "PENDING",
    canAddReceipt: own && e.status === "PENDING" && e.receiptKey === null,
  };
}

export async function addExpense(user: CurrentUser, raw: unknown, now: Date = new Date()): Promise<ExpenseDTO> {
  assertCan(user, "expenses.record");
  const parsed = addSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(fieldErrorsFromZod(parsed.error));
  const { amount, note } = parsed.data;
  const appointmentId = parsed.data.appointmentId || null;
  if (appointmentId) {
    // Technicians only see their own visits, the driver the car's: the same rule decides what they may claim for.
    const visible = await prisma.appointment.findFirst({ where: { AND: [{ id: appointmentId }, appointmentScope(user)] }, select: { id: true } });
    if (!visible) throw new NotFoundError("errors.appointmentNotFound");
  }
  const row = await prisma.$transaction(async (tx) => {
    const e = await tx.transportExpense.create({
      data: { userId: user.id, appointmentId, day: dbDate(todayKey(user.settings.timezone, now)), amount, note, createdAt: now },
      include,
    });
    await recordAudit(tx, {
      entityType: "EXPENSE",
      entityId: e.id,
      appointmentId,
      action: "EXPENSE_ADDED",
      summary: msg("audit.expenseAdded", { name: user.name, ...moneyParam("amount", amount) }),
      changes: { amount, note, appointment: e.appointment ? appointmentCode(e.appointment.number) : null },
      actorId: user.id,
    });
    return e;
  });
  return toDTO(user, row);
}

async function ownPending(user: CurrentUser, id: string) {
  if (typeof id !== "string" || id.length > 64) throw new NotFoundError();
  const e = await prisma.transportExpense.findUnique({ where: { id } });
  if (!e || (e.userId !== user.id && !hasPermission(user, "expenses.pay"))) throw new NotFoundError();
  if (e.userId !== user.id) throw new ForbiddenError();
  if (e.status !== "PENDING") throw new ValidationError({ _form: msg("expenses.errors.notPending") }, msg("expenses.errors.notPending"));
  return e;
}

/** The receipt photo, once, by the owner while the expense is pending. */
export async function addReceipt(user: CurrentUser, id: string, bytes: Uint8Array | null): Promise<ExpenseDTO> {
  assertCan(user, "expenses.record");
  if (!bytes) throw new ValidationError({ file: msg("attachments.errors.tooLarge") }, msg("attachments.errors.tooLarge"));
  const type = detectImageType(bytes);
  if (!type) throw new ValidationError({ file: msg("attachments.errors.type") }, msg("attachments.errors.type"));
  const e = await ownPending(user, id);
  if (e.receiptKey) throw new ValidationError({ file: msg("expenses.errors.hasReceipt") }, msg("expenses.errors.hasReceipt"));
  const key = await saveFile(bytes, type);
  try {
    // Only while still pending and without a receipt (two uploads at once: the second one loses).
    const done = await prisma.transportExpense.updateMany({ where: { id, receiptKey: null, status: "PENDING" }, data: { receiptKey: key, receiptContentType: type } });
    if (!done.count) throw new ValidationError({ file: msg("expenses.errors.hasReceipt") }, msg("expenses.errors.hasReceipt"));
  } catch (err) {
    await discardFile(key).catch(() => undefined);
    throw err;
  }
  return toDTO(user, await prisma.transportExpense.findUniqueOrThrow({ where: { id }, include }));
}

export async function readReceipt(user: CurrentUser, id: string): Promise<{ bytes: Buffer; contentType: string }> {
  if (typeof id !== "string" || id.length > 64) throw new NotFoundError();
  const e = await prisma.transportExpense.findUnique({ where: { id }, select: { userId: true, receiptKey: true, receiptContentType: true } });
  if (!e || !e.receiptKey || (e.userId !== user.id && !hasPermission(user, "expenses.pay"))) throw new NotFoundError();
  return { bytes: await readStoredFile(e.receiptKey), contentType: e.receiptContentType! };
}

export async function cancelExpense(user: CurrentUser, id: string): Promise<ExpenseDTO> {
  assertCan(user, "expenses.record");
  const e = await ownPending(user, id);
  const row = await prisma.$transaction(async (tx) => {
    const r = await tx.transportExpense.update({ where: { id: e.id, status: "PENDING" }, data: { status: "CANCELLED" }, include });
    await recordAudit(tx, {
      entityType: "EXPENSE",
      entityId: e.id,
      appointmentId: e.appointmentId,
      action: "EXPENSE_CANCELLED",
      summary: msg("audit.expenseCancelled", { name: user.name, ...moneyParam("amount", e.amount.toNumber()) }),
      changes: { status: { from: "PENDING", to: "CANCELLED" } },
      actorId: user.id,
    });
    return r;
  });
  return toDTO(user, row);
}

function monthRange(month: string) {
  const first = `${month}-01`;
  return { first, last: addDaysToKey(addMonthsToKey(startOfMonthKey(first), 1), -1) };
}

export type ExpenseSummary = { user: { id: string; name: string }; total: number; pending: number; count: number };

/** A month of expenses: everyone's for the accountant, otherwise the reader's own. */
export async function listExpenses(user: CurrentUser, monthRaw?: string, now: Date = new Date()) {
  const all = hasPermission(user, "expenses.pay");
  if (!all) assertCan(user, "expenses.record");
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(monthRaw ?? "") ? monthRaw! : todayKey(user.settings.timezone, now).slice(0, 7);
  const { first, last } = monthRange(month);
  const rows = await prisma.transportExpense.findMany({
    where: { day: { gte: dbDate(first), lte: dbDate(last) }, ...(all ? {} : { userId: user.id }) },
    include,
    orderBy: [{ day: "desc" }, { createdAt: "desc" }],
  });
  const items = rows.map((r) => toDTO(user, r));
  const byUser = new Map<string, ExpenseSummary>();
  for (const e of items) {
    if (e.status === "CANCELLED") continue;
    const s = byUser.get(e.user.id) ?? { user: e.user, total: 0, pending: 0, count: 0 };
    s.count++;
    s.total += e.amount;
    if (e.status === "PENDING") s.pending += e.amount;
    byUser.set(e.user.id, s);
  }
  const summary = [...byUser.values()].sort((a, b) => b.pending - a.pending || a.user.name.localeCompare(b.user.name));
  return { month, items, summary, canPay: all, total: summary.reduce((s, x) => s + x.total, 0), pending: summary.reduce((s, x) => s + x.pending, 0) };
}

const paySchema = z.object({ userId: z.string().max(64), month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) });

/** Pays out a person's pending expenses of a month (Aura api_expensePay) and tells them. */
export async function payExpenses(user: CurrentUser, raw: unknown, now: Date = new Date()) {
  assertCan(user, "expenses.pay");
  const parsed = paySchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(fieldErrorsFromZod(parsed.error));
  const { userId, month } = parsed.data;
  const { first, last } = monthRange(month);
  return prisma.$transaction(async (tx) => {
    const pending = await tx.transportExpense.findMany({ where: { userId, status: "PENDING", day: { gte: dbDate(first), lte: dbDate(last) } }, select: { id: true, amount: true } });
    if (!pending.length) return { count: 0, total: 0 };
    const total = pending.reduce((s, e) => s + e.amount.toNumber(), 0);
    await tx.transportExpense.updateMany({ where: { id: { in: pending.map((e) => e.id) }, status: "PENDING" }, data: { status: "PAID", paidAt: now, paidById: user.id } });
    const person = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { name: true } });
    await recordAudit(tx, {
      entityType: "EXPENSE",
      entityId: userId,
      action: "EXPENSES_PAID",
      summary: msg("audit.expensesPaid", { name: person.name, count: pending.length, ...moneyParam("amount", total) }),
      changes: { expenses: pending.map((e) => e.id), total },
      actorId: user.id,
    });
    await notifyUsers(tx, [userId], { type: "CASH", message: msg("notify.expensesPaid", { name: user.name, count: pending.length, ...moneyParam("amount", total) }) }, user.id);
    return { count: pending.length, total };
  });
}

/** The reader's visits of the last two weeks and tomorrow, to link an expense to. */
export async function recentVisitsFor(user: CurrentUser, now: Date = new Date()) {
  const tz = user.settings.timezone;
  const today = todayKey(tz, now);
  const range = dayRangeUtc(addDaysToKey(today, -14), addDaysToKey(today, 1), tz);
  const rows = await prisma.appointment.findMany({
    where: { AND: [appointmentScope(user), { startsAt: { gte: range.start, lt: range.end } }, { status: { kind: { not: "CANCELLED" } } }] },
    select: { id: true, number: true, startsAt: true, customer: { select: { name: true } } },
    orderBy: { startsAt: "desc" },
    take: 40,
  });
  return rows.map((r) => ({ id: r.id, code: appointmentCode(r.number), startsAt: r.startsAt.toISOString(), customerName: r.customer.name }));
}
