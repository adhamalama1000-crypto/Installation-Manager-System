import "server-only";
import { Prisma, type CustodyStatus, type PaymentMethod } from "@prisma/client";
import type { StatusKind } from "@prisma/client";
import { createT, msg } from "@/i18n/translator";
import { PAYMENT_METHODS, appointmentCode } from "@/lib/constants";
import { statusName } from "@/lib/format";
import { addDaysToKey, addMonthsToKey, dateKey, dayRangeUtc, fmt, todayKey } from "@/lib/time";
import type { PaymentDTO } from "@/lib/types";
import { cashReceiveSchema, fieldErrorsFromZod } from "@/lib/validation";
import { prisma, type Tx } from "../db";
import { moneyParam } from "../i18n-params";
import { assertCan, hasPermission } from "../access";
import type { CurrentUser } from "../auth/session";
import { ValidationError } from "../errors";
import { recordAudit } from "./audit";
import { notifyUsers } from "./notifications";
import { toCsv } from "./reports";

/**
 * Money for a visit (Aura: الإجمالي / العربون / الباقي / المتحصّل) and the cash technicians hold
 * until the accountant receives it (Aura: العهدة). Amounts are EGP, stored as NUMERIC(12,2).
 */

type MoneyRow = {
  totalPrice: Prisma.Decimal | null;
  depositAmount: Prisma.Decimal | null;
  depositMethod: PaymentMethod | null;
  extraFee: Prisma.Decimal | null;
  collectedAmount: Prisma.Decimal | null;
  collectedMethod: PaymentMethod | null;
  collectedAt: Date | null;
};

type Person = { id: string; name: string };
export type CustodyView = { status: CustodyStatus; holder: Person; receivedAt: Date | null; receivedBy: Person | null };

const num = (d: Prisma.Decimal | null) => (d === null ? null : d.toNumber());
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Price minus deposit plus extra fee; null when neither a price nor a fee is recorded. */
export function amountDue(a: Pick<MoneyRow, "totalPrice" | "depositAmount" | "extraFee">): number | null {
  if (a.totalPrice === null && a.extraFee === null) return null;
  return round2(Math.max(0, (num(a.totalPrice) ?? 0) - (num(a.depositAmount) ?? 0)) + (num(a.extraFee) ?? 0));
}

export function canSeePrices(user: CurrentUser) {
  return hasPermission(user, "appointments.manage") || hasPermission(user, "finance.view");
}

export function paymentDTO(user: CurrentUser, a: MoneyRow, collectedBy: Person | null, custody: CustodyView | null): PaymentDTO | null {
  const full = canSeePrices(user);
  // Technicians see what to collect on their own visits; viewers see no money at all.
  if (!full && user.role !== "TECHNICIAN") return null;
  const due = amountDue(a);
  const collected = num(a.collectedAmount);
  const base: PaymentDTO = {
    due,
    collectedAmount: collected,
    collectedMethod: a.collectedMethod,
    collectedAt: a.collectedAt?.toISOString() ?? null,
    collectedBy,
    balance: due === null ? null : round2(Math.max(0, due - (collected ?? 0))),
  };
  if (!full) return base;
  return {
    ...base,
    totalPrice: num(a.totalPrice),
    depositAmount: num(a.depositAmount),
    depositMethod: a.depositMethod,
    extraFee: num(a.extraFee),
    custody: custody
      ? { status: custody.status, holder: custody.holder, receivedAt: custody.receivedAt?.toISOString() ?? null, receivedBy: custody.receivedBy }
      : null,
  };
}

export async function loadCustody(appointmentId: string): Promise<CustodyView | null> {
  const c = await prisma.cashCustody.findUnique({
    where: { appointmentId },
    select: { status: true, receivedAt: true, technician: { select: { id: true, name: true } }, receivedBy: { select: { id: true, name: true } } },
  });
  return c ? { status: c.status, holder: c.technician, receivedAt: c.receivedAt, receivedBy: c.receivedBy } : null;
}

type CollectionTarget = MoneyRow & { id: string; technicians: { technicianId: string }[] };

/**
 * Validates a collection recorded with the visit outcome and returns the appointment fields to
 * write, the audit diff, and a step that keeps the cash custody row in line. Returns null when
 * nothing changes. Cash already handed to the accountant cannot be changed from the field.
 */
export async function prepareCollection(
  tx: Tx,
  user: CurrentUser,
  existing: CollectionTarget,
  amount: number | null | undefined,
  method: string | null | undefined,
  now: Date,
) {
  if (amount === undefined) return null;
  const nextMethod = amount ? (method as PaymentMethod) : null;
  const prevAmount = num(existing.collectedAmount);
  if (prevAmount === amount && existing.collectedMethod === nextMethod) return null;
  const due = amountDue(existing);
  if (amount && due !== null && amount > due + 1e-9) {
    const text = msg("paymentErrors.moreThanDue", moneyParam("due", due));
    throw new ValidationError({ collectedAmount: text }, text);
  }
  const custody = await tx.cashCustody.findUnique({ where: { appointmentId: existing.id } });
  if (custody?.status === "RECEIVED") {
    const text = msg("paymentErrors.alreadyHandedOver");
    throw new ValidationError({ collectedAmount: text }, text);
  }
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  if (prevAmount !== amount) changes.collectedAmount = { from: prevAmount, to: amount };
  if (existing.collectedMethod !== nextMethod) changes.collectedMethod = { from: existing.collectedMethod, to: nextMethod };

  const data = {
    collectedAmount: amount,
    collectedMethod: nextMethod,
    // 0 is a real answer ("the customer paid nothing"); null clears the record.
    collectedAt: amount === null ? null : now,
    collectedById: amount === null ? null : user.id,
  };

  async function syncCustody() {
    if (nextMethod === "CASH" && amount) {
      // The technician who took the cash holds it; a manager recording it for an unassigned visit
      // took it to the office, which counts as received straight away.
      const assigned = existing.technicians.map((t) => t.technicianId);
      const holder = assigned.includes(user.id) ? user.id : (assigned[0] ?? null);
      const state = holder
        ? { technicianId: holder, status: "HELD" as const, receivedById: null, receivedAt: null }
        : { technicianId: user.id, status: "RECEIVED" as const, receivedById: user.id, receivedAt: now };
      await tx.cashCustody.upsert({
        where: { appointmentId: existing.id },
        create: { appointmentId: existing.id, amount, collectedAt: now, ...state },
        update: { amount, collectedAt: now, ...state },
      });
    } else if (custody?.status === "HELD") {
      await tx.cashCustody.update({ where: { id: custody.id }, data: { status: "VOID" } });
    }
  }

  // An encoded message, used as a part of the visit-outcome notification.
  const summary = amount
    ? msg("payments.collectedPart", { ...moneyParam("amount", amount), method: `@enums.paymentMethod.${nextMethod!}` })
    : amount === 0
      ? msg("payments.collectedNothingPart")
      : null;
  return { data, changes, syncCustody, summary };
}

// ---------------------------------------------------------------------------------------------
// Cash custody
// ---------------------------------------------------------------------------------------------

/** The accountant confirms cash handed over by a technician: all of it, or chosen visits. */
export async function receiveCash(user: CurrentUser, raw: unknown, now: Date = new Date()) {
  assertCan(user, "cash.receive");
  const parsed = cashReceiveSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(fieldErrorsFromZod(parsed.error));
  const { technicianId, entryIds } = parsed.data;
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string; amount: Prisma.Decimal }[]>`
      SELECT id, amount FROM cash_custody
      WHERE "technicianId" = ${technicianId} AND status = 'HELD'
        ${entryIds ? Prisma.sql`AND id IN (${Prisma.join(entryIds)})` : Prisma.empty}
      ORDER BY "collectedAt", id
      FOR UPDATE`;
    if (entryIds && rows.length !== new Set(entryIds).size) {
      const text = msg("paymentErrors.someReceived");
      throw new ValidationError({ _form: text }, text);
    }
    const holder = await tx.user.findUnique({ where: { id: technicianId }, select: { name: true } });
    if (!rows.length || !holder) {
      const text = holder ? msg("paymentErrors.noCash", { name: holder.name }) : msg("paymentErrors.noCashUnknown");
      throw new ValidationError({ _form: text }, text);
    }
    await tx.cashCustody.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { status: "RECEIVED", receivedById: user.id, receivedAt: now } });
    const total = round2(rows.reduce((s, r) => s + r.amount.toNumber(), 0));
    await recordAudit(tx, {
      entityType: "CASH",
      entityId: technicianId,
      action: "CASH_RECEIVED",
      summary: msg("audit.cashReceived", { ...moneyParam("amount", total), name: holder.name, visits: `@${msg("common.visits", { count: rows.length })}` }),
      changes: { amount: total, visits: rows.length, entries: rows.map((r) => r.id) },
      actorId: user.id,
    });
    await notifyUsers(
      tx,
      [technicianId],
      { type: "CASH_RECEIVED", message: msg("notify.cashReceived", { name: user.name, ...moneyParam("amount", total), visits: `@${msg("common.visits", { count: rows.length })}` }) },
      user.id,
    );
    return { amount: total, count: rows.length };
  });
}

// ---------------------------------------------------------------------------------------------
// Monthly finance statement
// ---------------------------------------------------------------------------------------------

export function parseMonth(value: string | null | undefined, tz: string, now: Date = new Date()): string {
  return value && /^\d{4}-(0[1-9]|1[0-2])$/.test(value) ? value : todayKey(tz, now).slice(0, 7);
}

function monthRange(month: string, tz: string) {
  const first = `${month}-01`;
  return dayRangeUtc(first, addDaysToKey(addMonthsToKey(first, 1), -1), tz);
}

const D = (v: Prisma.Decimal | number | bigint | null) => (v === null ? 0 : Number(v));

export type OwedRow = {
  id: string;
  code: string;
  date: string;
  customerName: string;
  phone?: string;
  salesName: string;
  due: number;
  collected: number;
  balance: number;
};

/**
 * Aura's monthly statement for the visits of a month (by visit date, cancelled visits excluded):
 * prices, deposits and collections by method, extra fees, balances customers still owe on
 * completed visits, plus the cash technicians are holding right now.
 */
export async function financeStatement(user: CurrentUser, month: string) {
  assertCan(user, "finance.view");
  const tz = user.settings.timezone;
  const range = monthRange(month, tz);
  const inMonth = Prisma.sql`a."startsAt" >= ${range.start} AND a."startsAt" < ${range.end} AND s.kind <> 'CANCELLED'`;
  const canContact = hasPermission(user, "customers.contact");

  const [[totals], byMethod, owed, holdings, held] = await Promise.all([
    prisma.$queryRaw<{ visits: number; unpriced: number; totalSales: Prisma.Decimal; deposits: Prisma.Decimal; fees: Prisma.Decimal; collected: Prisma.Decimal }[]>`
      SELECT count(*)::int AS visits,
             count(*) FILTER (WHERE a."totalPrice" IS NULL AND s.kind = 'COMPLETED')::int AS unpriced,
             COALESCE(sum(a."totalPrice"), 0) AS "totalSales",
             COALESCE(sum(a."depositAmount"), 0) AS deposits,
             COALESCE(sum(a."extraFee"), 0) AS fees,
             COALESCE(sum(a."collectedAmount"), 0) AS collected
      FROM appointments a JOIN appointment_statuses s ON s.id = a."statusId"
      WHERE ${inMonth}`,
    prisma.$queryRaw<{ kind: "deposit" | "collected"; method: PaymentMethod; amount: Prisma.Decimal }[]>`
      SELECT 'deposit' AS kind, a."depositMethod" AS method, sum(a."depositAmount") AS amount
      FROM appointments a JOIN appointment_statuses s ON s.id = a."statusId"
      WHERE ${inMonth} AND a."depositAmount" > 0 GROUP BY a."depositMethod"
      UNION ALL
      SELECT 'collected', a."collectedMethod", sum(a."collectedAmount")
      FROM appointments a JOIN appointment_statuses s ON s.id = a."statusId"
      WHERE ${inMonth} AND a."collectedAmount" > 0 GROUP BY a."collectedMethod"`,
    prisma.$queryRaw<{ id: string; number: number; startsAt: Date; customerName: string; phone: string; salesName: string; due: Prisma.Decimal; collected: Prisma.Decimal; balance: Prisma.Decimal; total: bigint; owedTotal: Prisma.Decimal }[]>`
      WITH m AS (
        SELECT a.id, a.number, a."startsAt", a."customerId", a."createdById",
               GREATEST(COALESCE(a."totalPrice", 0) - COALESCE(a."depositAmount", 0), 0) + COALESCE(a."extraFee", 0) AS due,
               COALESCE(a."collectedAmount", 0) AS collected
        FROM appointments a JOIN appointment_statuses s ON s.id = a."statusId"
        WHERE ${inMonth} AND s.kind = 'COMPLETED' AND (a."totalPrice" IS NOT NULL OR a."extraFee" IS NOT NULL)
      )
      SELECT m.id, m.number, m."startsAt", c.name AS "customerName", c.phone, u.name AS "salesName",
             m.due, m.collected, m.due - m.collected AS balance,
             count(*) OVER () AS total, sum(m.due - m.collected) OVER () AS "owedTotal"
      FROM m JOIN customers c ON c.id = m."customerId" JOIN users u ON u.id = m."createdById"
      WHERE m.due - m.collected > 0
      ORDER BY balance DESC, m."startsAt", m.number
      LIMIT 500`,
    prisma.$queryRaw<{ technicianId: string; name: string; amount: Prisma.Decimal; visits: number; oldest: Date }[]>`
      SELECT k."technicianId", u.name, sum(k.amount) AS amount, count(*)::int AS visits, min(k."collectedAt") AS oldest
      FROM cash_custody k JOIN users u ON u.id = k."technicianId"
      WHERE k.status = 'HELD'
      GROUP BY k."technicianId", u.name
      ORDER BY amount DESC, u.name`,
    prisma.cashCustody.findMany({
      where: { status: "HELD" },
      select: {
        id: true,
        technicianId: true,
        amount: true,
        collectedAt: true,
        appointment: { select: { id: true, number: true, customer: { select: { name: true } } } },
      },
      orderBy: [{ collectedAt: "asc" }, { id: "asc" }],
      take: 500,
    }),
  ]);

  const methods = (kind: "deposit" | "collected") =>
    PAYMENT_METHODS.map((m) => ({ method: m, amount: D(byMethod.find((r) => r.kind === kind && r.method === m)?.amount ?? null) })).filter((r) => r.amount > 0);

  return {
    month,
    visits: totals?.visits ?? 0,
    unpriced: totals?.unpriced ?? 0,
    totalSales: D(totals?.totalSales ?? null),
    deposits: D(totals?.deposits ?? null),
    depositsByMethod: methods("deposit"),
    collected: D(totals?.collected ?? null),
    collectedByMethod: methods("collected"),
    fees: D(totals?.fees ?? null),
    owed: owed.map(
      (o): OwedRow => ({
        id: o.id,
        code: appointmentCode(o.number),
        date: dateKey(o.startsAt, tz),
        customerName: o.customerName,
        ...(canContact ? { phone: o.phone } : {}),
        salesName: o.salesName,
        due: D(o.due),
        collected: D(o.collected),
        balance: D(o.balance),
      }),
    ),
    owedCount: Number(owed[0]?.total ?? 0),
    owedTotal: D(owed[0]?.owedTotal ?? null),
    cashHeld: round2(holdings.reduce((s, h) => s + D(h.amount), 0)),
    holdings: holdings.map((h) => ({ technicianId: h.technicianId, name: h.name, amount: D(h.amount), visits: h.visits, oldest: h.oldest.toISOString() })),
    heldEntries: held.map((e) => ({
      id: e.id,
      technicianId: e.technicianId,
      amount: e.amount.toNumber(),
      collectedAt: e.collectedAt.toISOString(),
      appointmentId: e.appointment.id,
      code: appointmentCode(e.appointment.number),
      customerName: e.appointment.customer.name,
    })),
    canReceive: hasPermission(user, "cash.receive"),
  };
}

const FINANCE_EXPORT_LIMIT = 20_000;

/** One line per visit of the month with every amount (opens in Excel). */
export async function financeCsv(user: CurrentUser, month: string): Promise<string> {
  assertCan(user, "finance.view");
  const tz = user.settings.timezone;
  const range = monthRange(month, tz);
  const canContact = hasPermission(user, "customers.contact");
  const rows = await prisma.$queryRaw<
    {
      number: number;
      startsAt: Date;
      customerName: string;
      phone: string;
      salesName: string;
      status: string;
      statusAr: string | null;
      kind: StatusKind;
      totalPrice: Prisma.Decimal | null;
      depositAmount: Prisma.Decimal | null;
      depositMethod: PaymentMethod | null;
      extraFee: Prisma.Decimal | null;
      collectedAmount: Prisma.Decimal | null;
      collectedMethod: PaymentMethod | null;
      collectedBy: string | null;
      custody: CustodyStatus | null;
    }[]
  >`
    SELECT a.number, a."startsAt", c.name AS "customerName", c.phone, u.name AS "salesName", s.name AS status, s."nameAr" AS "statusAr", s.kind,
           a."totalPrice", a."depositAmount", a."depositMethod", a."extraFee", a."collectedAmount", a."collectedMethod",
           cb.name AS "collectedBy", k.status AS custody
    FROM appointments a
    JOIN appointment_statuses s ON s.id = a."statusId"
    JOIN customers c ON c.id = a."customerId"
    JOIN users u ON u.id = a."createdById"
    LEFT JOIN users cb ON cb.id = a."collectedById"
    LEFT JOIN cash_custody k ON k."appointmentId" = a.id
    WHERE a."startsAt" >= ${range.start} AND a."startsAt" < ${range.end} AND s.kind <> 'CANCELLED'
    ORDER BY a."startsAt", a.number
    LIMIT ${FINANCE_EXPORT_LIMIT}`;
  const t = createT(user.locale);
  const custodyLabel = (c: CustodyStatus) => (c === "VOID" ? "" : t.dyn(`enums.custodyStatus.${c}`));
  const header = [
    t("csv.appointment"),
    t("csv.date"),
    t("csv.customer"),
    ...(canContact ? [t("csv.phone")] : []),
    t("csv.sales"),
    t("csv.status"),
    t("csv.totalPrice"),
    t("csv.deposit"),
    t("csv.depositMethod"),
    t("csv.extraFee"),
    t("csv.dueAtVisit"),
    t("csv.collected"),
    t("csv.collectedMethod"),
    t("csv.balance"),
    t("csv.collectedBy"),
    t("csv.cash"),
  ];
  const lines = rows.map((r) => {
    const due = amountDue(r);
    const collected = num(r.collectedAmount);
    return [
      appointmentCode(r.number),
      fmt(r.startsAt, tz, "yyyy-MM-dd HH:mm"),
      r.customerName,
      ...(canContact ? [r.phone] : []),
      r.salesName,
      statusName({ name: r.status, nameAr: r.statusAr }, user.locale),
      num(r.totalPrice),
      num(r.depositAmount),
      r.depositMethod ? t.dyn(`enums.paymentMethod.${r.depositMethod}`) : "",
      num(r.extraFee),
      due,
      collected,
      r.collectedMethod ? t.dyn(`enums.paymentMethod.${r.collectedMethod}`) : "",
      due === null || r.kind !== "COMPLETED" ? null : round2(Math.max(0, due - (collected ?? 0))),
      r.collectedBy ?? "",
      r.custody ? custodyLabel(r.custody) : "",
    ];
  });
  return toCsv([header, ...lines]);
}
