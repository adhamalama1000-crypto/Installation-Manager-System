import "server-only";
import { Prisma, type StatusKind } from "@prisma/client";
import { addDaysToKey, addMonthsToKey, dayRangeUtc, startOfMonthKey, todayKey } from "@/lib/time";
import { prisma } from "../db";
import { appointmentScopeSql, hasPermission, peopleScope, peopleScopeSql, salesScope, vehicleScoped } from "../access";
import type { CurrentUser } from "../auth/session";

/**
 * The operational panels of the OR VIP dashboard. Every section is computed only when the reader
 * holds the permission of the page it links to, and with that page's data scope, so the dashboard
 * never shows a number the reader could not open. A section the reader may not see is `null`.
 */

const dbDate = (key: string) => new Date(`${key}T00:00:00.000Z`);
const num = (d: Prisma.Decimal | number | null | undefined) => (d === null || d === undefined ? 0 : Number(d));

export type OperationsOverview = Awaited<ReturnType<typeof operationsOverview>>;

export async function operationsOverview(user: CurrentUser, now: Date = new Date()) {
  const has = (p: Parameters<typeof hasPermission>[1]) => hasPermission(user, p);
  const tz = user.settings.timezone;
  const today = todayKey(tz, now);
  const todayRange = dayRangeUtc(today, today, tz);
  const monthStart = startOfMonthKey(today);
  const firstMonth = addMonthsToKey(monthStart, -5);

  const canAttendance = has("attendance.view") || has("attendance.manage");
  const canActivity = user.role !== "TECHNICIAN" && user.role !== "DRIVER" && has("appointments.view");
  const canWarehouse = (has("inventory.view") || has("warehouses.view")) && !vehicleScoped(user);
  const canSales = has("sales.view") || has("sales.manage");
  const canFinance = has("finance.view");
  const canEvidence = has("evidence.review");
  const canStockApprove = has("inventory.approve");
  const canPenalties = has("penalties.approve") && has("penalties.view");
  const canLeaves = has("leaves.manage");
  const canExpenses = has("expenses.pay");

  const none = Promise.resolve(null);
  const [attendance, activity, warehouse, sales, finance, approvals] = await Promise.all([
    // Attendance today: field staff who clock in (technicians and drivers) in the reader's scope.
    canAttendance
      ? (async () => {
          const staffWhere = { AND: [{ isActive: true, role: { in: ["TECHNICIAN", "DRIVER"] as ("TECHNICIAN" | "DRIVER")[] } }, peopleScope(user, "attendance")] };
          const [staff, clockIns, leave] = await Promise.all([
            prisma.user.count({ where: staffWhere }),
            prisma.checkIn.findMany({
              where: { day: dbDate(today), kind: "COMPANY", user: staffWhere },
              select: { userId: true, lateMinutes: true },
            }),
            prisma.technicianLeave.findMany({
              where: { status: "APPROVED", startDate: { lte: dbDate(today) }, endDate: { gte: dbDate(today) }, user: staffWhere },
              select: { userId: true },
            }),
          ]);
          const present = new Map<string, boolean>();
          for (const c of clockIns) present.set(c.userId, (present.get(c.userId) ?? false) || (c.lateMinutes ?? 0) > 0);
          const onLeave = new Set(leave.map((l) => l.userId).filter((id) => !present.has(id))).size;
          const late = [...present.values()].filter(Boolean).length;
          const onTime = present.size - late;
          return { staff, onTime, late, onLeave, notIn: Math.max(staff - present.size - onLeave, 0) };
        })()
      : none,

    // Installation and technician activity today, by status kind, plus technicians on the road.
    canActivity
      ? (async () => {
          const scope = appointmentScopeSql(user);
          const [rows, techs] = await Promise.all([
            prisma.$queryRaw<{ kind: StatusKind; n: number }[]>`
              SELECT s.kind, count(*)::int AS n FROM appointments a JOIN appointment_statuses s ON s.id = a."statusId"
              WHERE ${scope} AND a."startsAt" >= ${todayRange.start} AND a."startsAt" < ${todayRange.end}
              GROUP BY s.kind`,
            prisma.$queryRaw<{ n: number }[]>`
              SELECT count(DISTINCT x."technicianId")::int AS n FROM appointments a
              JOIN appointment_statuses s ON s.id = a."statusId"
              JOIN appointment_technicians x ON x."appointmentId" = a.id
              WHERE ${scope} AND s.kind <> 'CANCELLED' AND a."startsAt" >= ${todayRange.start} AND a."startsAt" < ${todayRange.end}`,
          ]);
          const by = (k: StatusKind) => rows.find((r) => r.kind === k)?.n ?? 0;
          return {
            scheduled: by("SCHEDULED"),
            inProgress: by("IN_PROGRESS"),
            completed: by("COMPLETED"),
            issues: by("UNABLE_TO_COMPLETE") + by("NEEDS_REVISIT") + by("POSTPONED"),
            technicians: techs[0]?.n ?? 0,
          };
        })()
      : none,

    // Warehouse indicators (company warehouses; vehicle-scoped readers only see their van elsewhere).
    canWarehouse
      ? (async () => {
          const [[low], drafts, counting] = await Promise.all([
            prisma.$queryRaw<{ low: number; out: number }[]>`
              SELECT count(*) FILTER (WHERE q < p."minStock")::int AS low, count(*) FILTER (WHERE q <= 0)::int AS out
              FROM (
                SELECT p.id, p."minStock", COALESCE(sum(b.quantity), 0) AS q
                FROM products p LEFT JOIN stock_balances b ON b."productId" = p.id
                WHERE p."isActive" AND p."minStock" > 0
                GROUP BY p.id, p."minStock"
              ) p`,
            prisma.stockDocument.count({ where: { status: "DRAFT" } }),
            prisma.stocktake.count({ where: { status: "COUNTING" } }),
          ]);
          return { lowStock: low?.low ?? 0, outOfStock: low?.out ?? 0, draftDocuments: drafts, countingNow: counting };
        })()
      : none,

    // Confirmed sales of the last six months (this month last), in the reader's sales scope.
    canSales
      ? (async () => {
          const where: Prisma.SalesInvoiceWhereInput = { AND: [salesScope(user), { status: "CONFIRMED", invoiceDate: { gte: dbDate(firstMonth) } }] };
          const [days, drafts] = await Promise.all([
            prisma.salesInvoice.groupBy({ by: ["invoiceDate"], where, _sum: { total: true }, _count: { _all: true } }),
            prisma.salesInvoice.count({ where: { AND: [salesScope(user), { status: "DRAFT" }] } }),
          ]);
          const months = Array.from({ length: 6 }, (_, i) => addMonthsToKey(firstMonth, i));
          const monthly = months.map((m) => {
            const rows = days.filter((d) => d.invoiceDate.toISOString().slice(0, 7) === m.slice(0, 7));
            return { month: m, total: rows.reduce((s, r) => s + num(r._sum.total), 0), count: rows.reduce((s, r) => s + r._count._all, 0) };
          });
          return { monthly, thisMonth: monthly[5]!, lastMonth: monthly[4]!, drafts };
        })()
      : none,

    // Finance: cash still held by technicians, and what was collected this month.
    canFinance
      ? (async () => {
          const monthRange = dayRangeUtc(monthStart, addDaysToKey(addMonthsToKey(monthStart, 1), -1), tz);
          const [held, received] = await Promise.all([
            prisma.cashCustody.aggregate({ where: { status: "HELD" }, _sum: { amount: true }, _count: { _all: true } }),
            prisma.cashCustody.aggregate({ where: { status: "RECEIVED", receivedAt: { gte: monthRange.start, lt: monthRange.end } }, _sum: { amount: true } }),
          ]);
          return { cashHeld: num(held._sum.amount), cashHeldCount: held._count._all, receivedThisMonth: num(received._sum.amount) };
        })()
      : none,

    // Pending approvals, each only for the people who decide them.
    (async () => {
      const [leaves, expenses, evidence, stocktakes, violations] = await Promise.all([
        canLeaves ? prisma.technicianLeave.count({ where: { status: "REQUESTED", user: peopleScope(user, "leaves") } }) : null,
        canExpenses ? prisma.transportExpense.count({ where: { status: "PENDING", user: peopleScope(user, "expenses") } }) : null,
        canEvidence
          ? prisma.$queryRaw<{ n: number }[]>`
              SELECT count(*)::int AS n FROM (
                SELECT DISTINCT ON (w."appointmentId") w."appointmentId", w.event FROM work_reviews w
                ORDER BY w."appointmentId", w."createdAt" DESC, w.id DESC
              ) l JOIN appointments a ON a.id = l."appointmentId"
              WHERE l.event = 'SUBMITTED' AND ${appointmentScopeSql(user)}`.then((r) => r[0]?.n ?? 0)
          : null,
        canStockApprove ? prisma.stocktake.count({ where: { status: "SUBMITTED" } }) : null,
        canPenalties
          ? prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM violations v WHERE v.status = 'PROPOSED' AND ${peopleScopeSql(user, "penalties", 'v."userId"')}`.then((r) => r[0]?.n ?? 0)
          : null,
      ]);
      const items = [
        { key: "leaves", count: leaves, href: "/leaves" },
        { key: "expenses", count: expenses, href: "/expenses" },
        { key: "evidence", count: evidence, href: "/evidence" },
        { key: "stocktakes", count: stocktakes, href: "/stocktakes" },
        { key: "violations", count: violations, href: "/penalties" },
      ].filter((i): i is { key: "leaves" | "expenses" | "evidence" | "stocktakes" | "violations"; count: number; href: string } => i.count !== null);
      return items.length ? items : null;
    })(),
  ]);

  return { attendance, activity, warehouse, sales, finance, approvals };
}
