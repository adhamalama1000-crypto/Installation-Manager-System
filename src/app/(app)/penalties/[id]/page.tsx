import Link from "next/link";
import type { Metadata } from "next";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { BackArrow, Badge, DefinitionList, PageHeader } from "@/components/ui/misc";
import { violationStatusTone } from "@/components/penalties/labels";
import { ViolationActions } from "@/components/penalties/violation-actions";
import { PenaltyBadge, violationText } from "@/components/penalties/violation-table";
import { getT } from "@/i18n/server";
import { money } from "@/lib/constants";
import { dateTime } from "@/lib/format";
import { formatKey } from "@/lib/time";
import { hasPermission } from "@/server/access";
import { requirePagePermission } from "@/server/auth/session";
import { getViolation } from "@/server/services/penalties";
import { loadOr404 } from "../../appointments/[id]/load";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("penalties.title") };
}

/** One violation: what happened, the penalty, and every step of its history and finance entries. */
export default async function ViolationPage({ params }: { params: Promise<{ id: string }> }) {
  const [user, t] = await Promise.all([requirePagePermission("penalties.own"), getT()]);
  const { id } = await params;
  const v = await loadOr404(() => getViolation(user, id));
  const tz = user.settings.timezone;
  const L = t.locale;
  const back = hasPermission(user, "penalties.view") ? "/penalties" : "/penalties/mine";
  const proposed = v.proposedKind === "WARNING" ? t("penalties.warning") : t("penalties.deductionOf", { amount: money(v.proposedAmount, L) });
  return (
    <>
      <PageHeader
        breadcrumb={
          <Link href={back} className="hover:text-fg">
            <BackArrow /> {hasPermission(user, "penalties.view") ? t("penalties.title") : t("penalties.mine")}
          </Link>
        }
        title={
          <span className="flex flex-wrap items-center gap-3">
            <bdi className="font-mono">{v.number}</bdi>
            <Badge className={`text-sm ${violationStatusTone[v.status]}`}>{t(`penalties.statuses.${v.status}`)}</Badge>
          </span>
        }
        description={`${v.user.name} · ${formatKey(v.occurredOn, { weekday: "long", day: "numeric", month: "long", year: "numeric" }, L)}`}
        actions={<ViolationActions v={v} size="md" />}
      />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Card>
          <CardHeader title={t("penalties.description")} />
          <CardBody>
            <p className="mb-5 whitespace-pre-line text-sm text-fg" dir="auto">
              {violationText(v, t)}
            </p>
            <DefinitionList
              items={[
                { label: t("penalties.rule"), value: v.rule ? (L === "ar" && v.rule.nameAr ? v.rule.nameAr : v.rule.name) : t(`penalties.triggers.${v.trigger}`) },
                { label: t("penalties.kind"), value: <PenaltyBadge v={v} t={t} /> },
                ...(v.kind !== v.proposedKind || v.amount !== v.proposedAmount ? [{ label: t("penalties.proposedLabel"), value: proposed }] : []),
                ...(v.minutes !== null ? [{ label: t("penalties.minutesLabel"), value: t("penalties.minutes", { minutes: v.minutes }) }] : []),
                ...(v.appointment
                  ? [
                      {
                        label: t("penalties.visit"),
                        value: (
                          <Link href={`/appointments/${v.appointment.id}`} className="font-mono text-brand-text hover:underline" dir="ltr">
                            {v.appointment.code}
                          </Link>
                        ),
                      },
                    ]
                  : []),
                ...(v.decisionNote ? [{ label: t("penalties.note"), value: <span className="whitespace-pre-line">{v.decisionNote}</span>, full: true }] : []),
                ...(v.cancelReason ? [{ label: t("penalties.reason"), value: <span className="whitespace-pre-line">{v.cancelReason}</span>, full: true }] : []),
              ]}
            />
          </CardBody>
        </Card>
        <div className="space-y-6">
          <Card>
            <CardHeader title={t("penalties.history")} />
            <ol className="space-y-3 border-s border-line p-5 ps-6 text-sm">
              {v.events.map((e) => (
                <li key={e.id}>
                  <p className="text-fg">{t(`penalties.events.${e.event}`, { name: e.by })}</p>
                  <p className="text-xs text-fg-subtle">
                    {dateTime(e.at, tz, L)} · {e.kind === "WARNING" ? t("penalties.warning") : t("penalties.deductionOf", { amount: money(e.amount, L) })}
                  </p>
                  {e.note && (
                    <p className="mt-0.5 whitespace-pre-line text-fg-muted" dir="auto">
                      {e.note}
                    </p>
                  )}
                </li>
              ))}
            </ol>
          </Card>
          {v.entries.length > 0 && (
            <Card>
              <CardHeader title={t("penalties.entries")} />
              <ul className="divide-y divide-line text-sm">
                {v.entries.map((e) => (
                  <li key={e.id} className="flex items-center justify-between px-5 py-2.5">
                    <span>
                      {t(`penalties.entryKinds.${e.kind}`)} · <bdi dir="ltr">{e.month}</bdi>
                    </span>
                    <span className={`tabular-nums ${e.amount < 0 ? "text-success" : "text-danger"}`} dir="ltr">
                      {money(e.amount, L)}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
