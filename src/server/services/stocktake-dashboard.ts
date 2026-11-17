import "server-only";
import { Prisma, type StocktakeStatus } from "@prisma/client";
import { dateKey, dayRangeUtc, isValidDateString } from "@/lib/time";
import { prisma } from "../db";
import { hasPermission } from "../access";
import type { CurrentUser } from "../auth/session";
import { NotFoundError } from "../errors";
import { num, warehouseScope } from "./inventory-common";
import { isOverdue } from "./stocktakes";
import { planSessions } from "./stocktake-schedules";

/**
 * The stocktake dashboard: today's and upcoming sessions, the month and year calendars, active,
 * completed and overdue sessions, approvals waiting, discrepancies, products with repeated
 * discrepancies, and each warehouse's record. Everything follows the reader's warehouse scope.
 */

export type DashboardFilters = { warehouseId?: string; userId?: string; productId?: string; categoryId?: string; from?: string; to?: string; status?: string; month?: string };

const OPEN: StocktakeStatus[] = ["COUNTING", "SUBMITTED"];

export async function stocktakeDashboard(user: CurrentUser, f: DashboardFilters, now = new Date()) {
  if (!hasPermission(user, "inventory.count") && !hasPermission(user, "inventory.approve") && !hasPermission(user, "stocktakes.schedule")) throw new NotFoundError();
  const tz = user.settings.timezone;
  await planSessions(tz, undefined, now);
  const todayKey = dateKey(now, tz);
  const month = f.month && /^\d{4}-\d{2}$/.test(f.month) ? f.month : todayKey.slice(0, 7);
  const year = Number(month.slice(0, 4));
  const from = f.from && isValidDateString(f.from) ? f.from : `${year}-01-01`;
  const to = f.to && isValidDateString(f.to) ? f.to : `${year}-12-31`;
  const range = dayRangeUtc(from, to, tz);

  const scope: Prisma.StocktakeWhereInput[] = [{ warehouse: warehouseScope(user) }];
  if (f.warehouseId) scope.push({ warehouseId: f.warehouseId });
  if (f.userId) scope.push({ OR: [{ assigneeIds: { has: f.userId } }, { supervisorId: f.userId }, { counts: { some: { countedById: f.userId } } }, { createdById: f.userId }] });
  if (f.productId) scope.push({ OR: [{ productIds: { has: f.productId } }, { lines: { some: { productId: f.productId } } }] });
  if (f.categoryId) scope.push({ OR: [{ categoryIds: { has: f.categoryId } }, { lines: { some: { product: { OR: [{ categoryId: f.categoryId }, { category: { parentId: f.categoryId } }] } } } }] });
  if (f.status) scope.push({ status: f.status as StocktakeStatus });
  // The day a session belongs to: its planned start, or when it was started / created.
  const when = (s: { plannedStart: Date | null; startedAt: Date | null; createdAt: Date }) => s.plannedStart ?? s.startedAt ?? s.createdAt;

  const sessions = await prisma.stocktake.findMany({
    where: { AND: [...scope, { OR: [{ plannedStart: { gte: range.start, lt: range.end } }, { plannedStart: null, createdAt: { gte: range.start, lt: range.end } }, { status: { in: [...OPEN, "PLANNED"] } }] }] },
    include: { warehouse: { select: { id: true, code: true, nameEn: true, nameAr: true } }, _count: { select: { lines: true } } },
    orderBy: [{ plannedStart: "asc" }, { createdAt: "asc" }],
  });
  const card = (s: (typeof sessions)[number]) => ({
    id: s.id,
    number: s.number,
    name: s.name,
    kind: s.kind,
    status: s.status,
    warehouse: s.warehouse,
    plannedStart: s.plannedStart?.toISOString() ?? null,
    plannedEnd: s.plannedEnd?.toISOString() ?? null,
    mandatory: s.mandatory,
    overdue: isOverdue(s, now),
    lines: s._count.lines,
    day: dateKey(when(s), tz),
  });
  const all = sessions.map(card);
  const upcomingEnd = dateKey(new Date(now.getTime() + 14 * 86_400_000), tz);

  // Month calendar (sessions per day) and year calendar (per month and status).
  const calendar: Record<string, ReturnType<typeof card>[]> = {};
  for (const c of all) if (c.day.startsWith(month)) (calendar[c.day] ??= []).push(c);
  const yearly = Array.from({ length: 12 }, (_, i) => {
    const m = `${year}-${String(i + 1).padStart(2, "0")}`;
    const inMonth = all.filter((c) => c.day.startsWith(m));
    return { month: m, total: inMonth.length, approved: inMonth.filter((c) => c.status === "APPROVED").length, planned: inMonth.filter((c) => c.status === "PLANNED").length, overdue: inMonth.filter((c) => c.overdue).length };
  });

  // Discrepancies of approved sessions in the period.
  const diffRows = await prisma.$queryRaw<
    { stocktakeId: string; number: string; warehouseCode: string; productId: string; sku: string; nameEn: string; nameAr: string; systemQuantity: Prisma.Decimal; countedQuantity: Prisma.Decimal; damagedQuantity: Prisma.Decimal | null; decidedAt: Date }[]
  >`
    SELECT s.id AS "stocktakeId", s.number, w.code AS "warehouseCode", p.id AS "productId", p.sku, p."nameEn", p."nameAr",
           l."systemQuantity", l."countedQuantity", l."damagedQuantity", s."decidedAt"
    FROM stocktake_lines l
    JOIN stocktakes s ON s.id = l."stocktakeId"
    JOIN warehouses w ON w.id = s."warehouseId"
    JOIN products p ON p.id = l."productId"
    WHERE s.status = 'APPROVED' AND s."decidedAt" >= ${range.start} AND s."decidedAt" < ${range.end}
      AND l."countedQuantity" IS NOT NULL AND (l."countedQuantity" <> l."systemQuantity" OR COALESCE(l."damagedQuantity", 0) > 0)
      AND s.id = ANY(${sessions.filter((s) => s.status === "APPROVED").map((s) => s.id)}::text[])
      ${f.productId ? Prisma.sql`AND p.id = ${f.productId}` : Prisma.empty}
    ORDER BY s."decidedAt" DESC
    LIMIT 500`;
  const discrepancies = diffRows.map((r) => {
    const system = num(r.systemQuantity);
    const counted = num(r.countedQuantity);
    return { stocktakeId: r.stocktakeId, number: r.number, warehouse: r.warehouseCode, product: { id: r.productId, sku: r.sku, nameEn: r.nameEn, nameAr: r.nameAr }, system, counted, difference: Math.round((counted - system) * 1000) / 1000, damaged: r.damagedQuantity === null ? 0 : num(r.damagedQuantity), decidedAt: r.decidedAt.toISOString() };
  });
  const byProduct = new Map<string, { product: (typeof discrepancies)[number]["product"]; sessions: Set<string>; net: number }>();
  for (const d of discrepancies) {
    if (d.difference === 0) continue;
    const e = byProduct.get(d.product.id) ?? { product: d.product, sessions: new Set<string>(), net: 0 };
    e.sessions.add(d.stocktakeId);
    e.net = Math.round((e.net + d.difference) * 1000) / 1000;
    byProduct.set(d.product.id, e);
  }
  const repeated = [...byProduct.values()].filter((e) => e.sessions.size >= 2).map((e) => ({ product: e.product, sessions: e.sessions.size, net: e.net })).sort((a, b) => b.sessions - a.sessions);

  // Each warehouse's record over the period.
  const perWarehouse = new Map<string, { warehouse: (typeof all)[number]["warehouse"]; completed: number; onTime: number; late: number; overdue: number; lines: number; exact: number }>();
  const lineStats = await prisma.stocktakeLine.groupBy({
    by: ["stocktakeId"],
    where: { stocktakeId: { in: sessions.filter((s) => s.status === "APPROVED").map((s) => s.id) } },
    _count: { _all: true },
  });
  const exactStats = await prisma.$queryRaw<{ stocktakeId: string; exact: bigint }[]>`
    SELECT "stocktakeId", count(*) AS exact FROM stocktake_lines
    WHERE "stocktakeId" = ANY(${sessions.filter((s) => s.status === "APPROVED").map((s) => s.id)}::text[]) AND "countedQuantity" = "systemQuantity"
    GROUP BY "stocktakeId"`;
  const linesOf = new Map(lineStats.map((r) => [r.stocktakeId, r._count._all]));
  const exactOf = new Map(exactStats.map((r) => [r.stocktakeId, Number(r.exact)]));
  for (const s of sessions) {
    const e = perWarehouse.get(s.warehouseId) ?? { warehouse: s.warehouse, completed: 0, onTime: 0, late: 0, overdue: 0, lines: 0, exact: 0 };
    if (s.status === "APPROVED") {
      e.completed++;
      if (!s.plannedEnd || (s.decidedAt && s.decidedAt <= s.plannedEnd)) e.onTime++;
      else e.late++;
      e.lines += linesOf.get(s.id) ?? 0;
      e.exact += exactOf.get(s.id) ?? 0;
    }
    if (isOverdue(s, now)) e.overdue++;
    perWarehouse.set(s.warehouseId, e);
  }

  return {
    month,
    year,
    from,
    to,
    today: all.filter((c) => c.day === todayKey || OPEN.includes(c.status as StocktakeStatus)),
    upcoming: all.filter((c) => c.status === "PLANNED" && c.day > todayKey && c.day <= upcomingEnd),
    active: all.filter((c) => OPEN.includes(c.status as StocktakeStatus)),
    completed: all.filter((c) => c.status === "APPROVED").slice(-20).reverse(),
    overdue: all.filter((c) => c.overdue),
    pendingApproval: all.filter((c) => c.status === "SUBMITTED"),
    calendar,
    yearly,
    discrepancies: discrepancies.slice(0, 100),
    repeated,
    warehouses: [...perWarehouse.values()].map((e) => ({ ...e, accuracy: e.lines ? Math.round((e.exact / e.lines) * 1000) / 10 : null })),
  };
}
export type StocktakeDashboard = Awaited<ReturnType<typeof stocktakeDashboard>>;
