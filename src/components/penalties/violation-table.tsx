import Link from "next/link";
import { Gavel } from "lucide-react";
import { Badge, EmptyState } from "@/components/ui/misc";
import { tableHead, th, thEnd } from "@/components/erp/labels";
import type { T } from "@/i18n/translator";
import { money } from "@/lib/constants";
import { formatKey } from "@/lib/time";
import type { ViolationDTO } from "@/server/services/penalties";
import { violationKindTone, violationStatusTone } from "./labels";
import { ViolationActions } from "./violation-actions";

/** What happened: typed by a person (as typed), or found by a rule (a message in the reader's language). */
export function violationText(v: Pick<ViolationDTO, "trigger" | "description">, t: T) {
  return v.trigger === "MANUAL" ? v.description : t.msg(v.description);
}

export function PenaltyBadge({ v, t }: { v: Pick<ViolationDTO, "kind" | "amount">; t: T }) {
  return <Badge className={violationKindTone[v.kind]}>{v.kind === "WARNING" ? t("penalties.warning") : t("penalties.deductionOf", { amount: money(v.amount, t.locale) })}</Badge>;
}

/** Violations as a table (the list page and an employee's own page). */
export function ViolationTable({ rows, t, showPerson = true, empty }: { rows: ViolationDTO[]; t: T; showPerson?: boolean; empty: string }) {
  if (!rows.length) return <EmptyState title={empty} icon={<Gavel className="h-6 w-6" />} />;
  const anyActions = rows.some((r) => r.can.decide || r.can.cancel);
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-sm">
        <thead className={tableHead}>
          <tr>
            <th className={th}>{t("penalties.number")}</th>
            {showPerson && <th className={th}>{t("penalties.employee")}</th>}
            <th className={th}>{t("penalties.date")}</th>
            <th className={th}>{t("penalties.description")}</th>
            <th className={th}>{t("penalties.kind")}</th>
            <th className={th}>{t("penalties.status")}</th>
            {anyActions && <th className={thEnd}>{t("common.actions")}</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((v) => (
            <tr key={v.id} className="align-top hover:bg-surface-muted/50">
              <td className="whitespace-nowrap px-4 py-2.5">
                <Link prefetch={false} href={`/penalties/${v.id}`} className="font-mono font-semibold text-brand-text hover:underline" dir="ltr">
                  {v.number}
                </Link>
              </td>
              {showPerson && <td className="px-4 py-2.5">{v.user.name}</td>}
              <td className="whitespace-nowrap px-4 py-2.5 text-fg-muted">{formatKey(v.occurredOn, { day: "numeric", month: "short", year: "numeric" }, t.locale)}</td>
              <td className="max-w-sm px-4 py-2.5">
                <span className="block text-xs text-fg-subtle">{v.rule ? (t.locale === "ar" && v.rule.nameAr ? v.rule.nameAr : v.rule.name) : t(`penalties.triggers.${v.trigger}`)}</span>
                <span className="line-clamp-2" dir="auto">
                  {violationText(v, t)}
                </span>
              </td>
              <td className="whitespace-nowrap px-4 py-2.5">
                <PenaltyBadge v={v} t={t} />
              </td>
              <td className="whitespace-nowrap px-4 py-2.5">
                <Badge className={violationStatusTone[v.status]}>{t(`penalties.statuses.${v.status}`)}</Badge>
              </td>
              {anyActions && (
                <td className="px-4 py-2.5">
                  <ViolationActions v={v} />
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
