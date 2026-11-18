import Link from "next/link";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Card, CardBody } from "@/components/ui/card";
import { Alert, BackArrow, PageHeader } from "@/components/ui/misc";
import { StocktakeBadge } from "@/components/erp/badges";
import { StocktakeSheet } from "@/components/erp/stocktake-forms";
import { PlannedPanel, StocktakePhotos } from "@/components/erp/stocktake-planning";
import { dateKey, timeKey } from "@/lib/time";
import { prisma } from "@/server/db";
import { nameOf } from "@/components/erp/labels";
import { getT } from "@/i18n/server";
import { dateTime } from "@/lib/format";
import { hasPermission } from "@/server/access";
import { requireUser } from "@/server/auth/session";
import { getStocktake } from "@/server/services/stocktakes";
import { loadOr404 } from "../../appointments/[id]/load";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("stocktakes.title") };
}

export default async function StocktakePage({ params }: { params: Promise<{ id: string }> }) {
  const [user, t] = await Promise.all([requireUser(), getT()]);
  if (!hasPermission(user, "inventory.count") && !hasPermission(user, "inventory.approve")) redirect("/access-denied");
  const { id } = await params;
  const s = await loadOr404(() => getStocktake(user, id));
  const tz = user.settings.timezone;
  const L = t.locale;
  const closed = s.status === "APPROVED" || s.status === "REJECTED" || s.status === "CANCELLED";
  const planned = s.status === "PLANNED";
  // People who may be assigned or supervise: active staff who can count or approve stock.
  const people = s.can.editPlan
    ? await prisma.user.findMany({ where: { isActive: true, role: { in: ["ADMIN", "STORE", "WAREHOUSE_MANAGER"] } }, select: { id: true, name: true }, orderBy: { name: "asc" } })
    : [];
  return (
    <>
      <PageHeader
        breadcrumb={
          <Link href="/stocktakes" className="hover:text-fg">
            <BackArrow /> {t("stocktakes.backToList")}
          </Link>
        }
        title={
          <span className="flex flex-wrap items-center gap-3">
            <bdi className="font-mono">{s.number}</bdi>
            <StocktakeBadge status={s.status} label={t.dyn(`enums.stocktakeStatus.${s.status}`)} className="text-sm" />
            {s.overdue && <span className="rounded-full border border-danger/40 bg-danger-soft px-2.5 py-0.5 text-sm font-medium text-fg">{t("stocktakePlan.overdueBadge")}</span>}
            {s.mandatory && <span className="rounded-full border border-line px-2.5 py-0.5 text-sm text-fg-muted">{t("stocktakePlan.mandatoryBadge")}</span>}
          </span>
        }
        description={
          <>
            <bdi className="font-mono">{s.warehouse.code}</bdi> {nameOf(s.warehouse, t)}
          </>
        }
      />
      <Card className="mb-6">
        <CardBody className="space-y-1 text-sm text-fg-muted">
          {s.name && (
            <p className="font-medium text-fg" dir="auto">
              {s.name}
              {s.kind && <span className="ms-2 text-xs font-normal text-fg-muted">· {t.dyn(`stocktakePlan.kinds.${s.kind}`)}</span>}
            </p>
          )}
          {s.plannedStart && <p>{t("stocktakePlan.plannedFor", { when: `${dateTime(s.plannedStart, tz, L)}${s.plannedEnd ? ` – ${timeKey(s.plannedEnd, tz)}` : ""}` })}</p>}
          {s.postponedFrom && <p>{t("stocktakePlan.postponedFrom", { when: dateTime(s.postponedFrom, tz, L), reason: s.postponeReason ?? "" })}</p>}
          {(s.plannedStart || s.assignees.length > 0 || s.supervisor) && (
            <p>
              {t("stocktakePlan.fields.assignees")}: {s.assignees.length ? s.assignees.map((a) => a.name).join(L === "ar" ? "، " : ", ") : t("stocktakePlan.anyone")} · {t("stocktakePlan.fields.supervisor")}: {s.supervisor?.name ?? t("stocktakePlan.noSupervisor")}
            </p>
          )}
          <p>
            {t("stocktakePlan.scope")}: {s.categoryIds.length || s.productIds.length ? t("stocktakePlan.scopeCount", { categories: s.categoryIds.length, products: s.productIds.length }) : t("stocktakePlan.wholeWarehouse")}
          </p>
          {s.instructions && (
            <p className="whitespace-pre-line text-fg" dir="auto">
              {t("stocktakePlan.instructions")}: {s.instructions}
            </p>
          )}
          {s.snapshotAt && <p>{t("stocktakes.snapshotAt", { when: dateTime(s.snapshotAt, tz, L), name: s.startedBy?.name ?? s.createdBy.name })}</p>}
          {s.round > 0 && <p className="font-medium text-warning">{t("stocktakePlan.round", { round: s.round + 1 })}</p>}
          {!planned && (
            <p className="font-medium text-fg" role="status">
              {t("stocktakes.progress", { counted: s.summary.counted, lines: s.summary.lines, differences: s.summary.differences })}
              {s.summary.missing > 0 && ` · ${t("stocktakePlan.missing")}: ${s.summary.missing}`}
              {s.summary.excess > 0 && ` · ${t("stocktakePlan.excess")}: ${s.summary.excess}`}
              {s.summary.damaged > 0 && ` · ${t("stocktakePlan.damaged")}: ${s.summary.damaged}`}
            </p>
          )}
          {s.submittedBy && s.submittedAt && <p>{t("stocktakes.submittedBy", { name: s.submittedBy.name, when: dateTime(s.submittedAt, tz, L) })}</p>}
          {s.decidedBy && s.decidedAt && (
            <p>
              {t("stocktakes.decision", { status: t.dyn(`enums.stocktakeStatus.${s.status}`), name: s.decidedBy.name, when: dateTime(s.decidedAt, tz, L) })}
              {s.decisionNote && <span dir="auto"> · {s.decisionNote}</span>}
            </p>
          )}
          {s.adjustment && (
            <p>
              <Link href={`/stock/documents/${s.adjustment.id}`} className="font-medium text-brand-text hover:underline">
                {t("stocktakes.adjustment", { number: s.adjustment.number })}
              </Link>
            </p>
          )}
          {s.note && <p dir="auto">{s.note}</p>}
        </CardBody>
      </Card>
      {planned ? (
        <PlannedPanel
          id={s.id}
          number={s.number}
          version={s.version}
          date={s.plannedStart ? dateKey(s.plannedStart, tz) : ""}
          startTime={s.plannedStart ? timeKey(s.plannedStart, tz) : "09:00"}
          durationMinutes={s.plannedStart && s.plannedEnd ? Math.round((Date.parse(s.plannedEnd) - Date.parse(s.plannedStart)) / 60000) : 60}
          assigneeIds={s.assignees.map((a) => a.id)}
          supervisorId={s.supervisor?.id ?? null}
          instructions={s.instructions}
          mandatory={s.mandatory}
          people={people}
          can={{ start: s.can.start, editPlan: s.can.editPlan, cancel: s.can.cancel }}
        />
      ) : (
        <>
          {!closed && (
            <Alert tone="info" className="mb-4" title={t("warehouses.frozen")}>
              {t("warehouses.frozenText", { number: s.number })}
            </Alert>
          )}
          <StocktakeSheet id={s.id} number={s.number} warehouseId={s.warehouse.id} bins={s.warehouse.bins} lines={s.lines} can={s.can} decisionBlocked={s.decisionBlocked} />
          <StocktakePhotos id={s.id} photos={s.photos} canAdd={s.can.photo} />
        </>
      )}
    </>
  );
}
