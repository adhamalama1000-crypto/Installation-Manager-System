import Link from "next/link";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Card, CardBody } from "@/components/ui/card";
import { Alert, BackArrow, PageHeader } from "@/components/ui/misc";
import { StocktakeBadge } from "@/components/erp/badges";
import { StocktakeSheet } from "@/components/erp/stocktake-forms";
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
          <p>{t("stocktakes.snapshotAt", { when: dateTime(s.snapshotAt, tz, L), name: s.createdBy.name })}</p>
          <p className="font-medium text-fg" role="status">
            {t("stocktakes.progress", { counted: s.summary.counted, lines: s.summary.lines, differences: s.summary.differences })}
          </p>
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
      {!closed && (
        <Alert tone="info" className="mb-4" title={t("warehouses.frozen")}>
          {t("warehouses.frozenText", { number: s.number })}
        </Alert>
      )}
      <StocktakeSheet id={s.id} number={s.number} warehouseId={s.warehouse.id} bins={s.warehouse.bins} lines={s.lines} can={s.can} />
    </>
  );
}
