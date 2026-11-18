import Link from "next/link";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { CalendarClock } from "lucide-react";
import { Card } from "@/components/ui/card";
import { BackArrow, EmptyState, PageHeader } from "@/components/ui/misc";
import { ScheduleForm, type ScheduleValues } from "@/components/erp/schedule-form";
import { nameOf, tableHead, th } from "@/components/erp/labels";
import { getT } from "@/i18n/server";
import { todayKey } from "@/lib/time";
import { hasPermission } from "@/server/access";
import { requireUser } from "@/server/auth/session";
import { prisma } from "@/server/db";
import { catalogOptions } from "@/server/services/inventory-catalog";
import { warehouseOptions } from "@/server/services/inventory-warehouses";
import { listSchedules } from "@/server/services/stocktake-schedules";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("stocktakePlan.schedules") };
}

/** Stocktake schedules: daily, monthly, annual and custom plans (planners edit; counters and approvers read). */
export default async function SchedulesPage() {
  const [user, t] = await Promise.all([requireUser(), getT()]);
  if (!hasPermission(user, "stocktakes.schedule") && !hasPermission(user, "inventory.approve") && !hasPermission(user, "inventory.count")) redirect("/access-denied");
  const canPlan = hasPermission(user, "stocktakes.schedule");
  const [schedules, warehouses, catalog, people] = await Promise.all([
    listSchedules(user),
    warehouseOptions(user),
    canPlan ? catalogOptions(user) : Promise.resolve(null),
    canPlan ? prisma.user.findMany({ where: { isActive: true, role: { in: ["ADMIN", "STORE", "WAREHOUSE_MANAGER"] } }, select: { id: true, name: true }, orderBy: { name: "asc" } }) : Promise.resolve([]),
  ]);
  const productLabels = new Map(
    (await prisma.product.findMany({ where: { id: { in: schedules.flatMap((s) => s.productIds) } }, select: { id: true, sku: true } })).map((p) => [p.id, p.sku]),
  );
  const wOptions = warehouses.map((w) => ({ id: w.id, label: `${w.code} · ${nameOf(w, t)}` }));
  const cOptions = (catalog?.categories ?? []).filter((c) => c.isActive).map((c) => ({ id: c.id, label: nameOf(c, t) }));
  const blank: ScheduleValues = {
    name: "",
    nameAr: "",
    warehouseId: warehouses[0]?.id ?? "",
    kind: "MONTHLY",
    recurrence: "MONTHLY",
    interval: "1",
    startDate: todayKey(user.settings.timezone),
    endDate: "",
    startTime: "09:00",
    durationMinutes: "240",
    assigneeIds: [],
    supervisorId: "",
    categoryIds: [],
    products: [],
    mandatory: false,
    instructions: "",
    status: "ACTIVE",
  };
  const name = (x: { name: string; nameAr: string | null }) => (t.locale === "ar" && x.nameAr ? x.nameAr : x.name);
  return (
    <>
      <PageHeader
        breadcrumb={
          <Link href="/stocktakes" className="hover:text-fg">
            <BackArrow /> {t("stocktakes.backToList")}
          </Link>
        }
        title={t("stocktakePlan.schedules")}
        description={t("stocktakePlan.schedulesText")}
        actions={canPlan && warehouses.length > 0 ? <ScheduleForm initial={blank} warehouses={wOptions} people={people} categories={cOptions} /> : undefined}
      />
      <Card className="overflow-hidden">
        {schedules.length === 0 ? (
          <EmptyState title={t("stocktakePlan.noSchedules")} icon={<CalendarClock className="h-6 w-6" />} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm" aria-label={t("stocktakePlan.schedules")}>
              <thead className={tableHead}>
                <tr>
                  <th className={th}>{t("stocktakePlan.fields.name")}</th>
                  <th className={th}>{t("stocktakePlan.fields.warehouse")}</th>
                  <th className={th}>{t("stocktakePlan.fields.recurrence")}</th>
                  <th className={th}>{t("stocktakePlan.fields.startTime")}</th>
                  <th className={th}>{t("stocktakePlan.fields.status")}</th>
                  <th className={th} />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {schedules.map((s) => (
                  <tr key={s.id} data-schedule={s.name}>
                    <td className="px-4 py-2.5">
                      <span className="font-medium" dir="auto">
                        {name(s)}
                      </span>
                      <span className="block text-xs text-fg-muted">
                        {t.dyn(`stocktakePlan.kinds.${s.kind}`)} · {t("stocktakePlan.sessions", { count: s.sessions })}
                        {s.mandatory && ` · ${t("stocktakePlan.mandatoryBadge")}`}
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      <bdi className="font-mono">{s.warehouse.code}</bdi>
                    </td>
                    <td className="px-4 py-2.5">
                      {t.dyn(`stocktakePlan.recurrences.${s.recurrence}`)}
                      {s.recurrence !== "NONE" && s.interval > 1 && ` × ${s.interval}`}
                      {s.next && <span className="block text-xs text-fg-muted">{t("stocktakePlan.next", { date: s.next })}</span>}
                    </td>
                    <td className="px-4 py-2.5 tabular-nums">
                      <bdi>{s.startTime}</bdi>
                    </td>
                    <td className="px-4 py-2.5">{t.dyn(`stocktakePlan.scheduleStatuses.${s.status}`)}</td>
                    <td className="px-4 py-2.5 text-end">
                      {canPlan && (
                        <ScheduleForm
                          initial={{
                            id: s.id,
                            version: s.version,
                            name: s.name,
                            nameAr: s.nameAr ?? "",
                            warehouseId: s.warehouse.id,
                            kind: s.kind,
                            recurrence: s.recurrence,
                            interval: String(s.interval),
                            startDate: s.startDate,
                            endDate: s.endDate ?? "",
                            startTime: s.startTime,
                            durationMinutes: String(s.durationMinutes),
                            assigneeIds: s.assigneeIds,
                            supervisorId: s.supervisor?.id ?? "",
                            categoryIds: s.categoryIds,
                            products: s.productIds.map((id) => ({ id, label: productLabels.get(id) ?? id })),
                            mandatory: s.mandatory,
                            instructions: s.instructions ?? "",
                            status: s.status,
                          }}
                          warehouses={wOptions}
                          people={people}
                          categories={cOptions}
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
