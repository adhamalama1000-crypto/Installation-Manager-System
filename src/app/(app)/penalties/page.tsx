import Link from "next/link";
import type { Metadata } from "next";
import { ListChecks } from "lucide-react";
import { buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/misc";
import { Pagination } from "@/components/ui/pagination";
import { control, submitBtn } from "@/components/erp/labels";
import { FindViolations, RecordViolation } from "@/components/penalties/penalty-tools";
import { ViolationTable } from "@/components/penalties/violation-table";
import { getT } from "@/i18n/server";
import { money } from "@/lib/constants";
import { VIOLATION_STATUSES } from "@/lib/penalties";
import { addDaysToKey, todayKey } from "@/lib/time";
import { hasPermission } from "@/server/access";
import { requirePagePermission } from "@/server/auth/session";
import { listPenaltyRules, listViolations, violationPeople } from "@/server/services/penalties";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("penalties.title") };
}

type SP = { status?: string; userId?: string; month?: string; page?: string };

/** Everyone's violations: proposed ones to decide, and the record of decided ones. */
export default async function PenaltiesPage({ searchParams }: { searchParams: Promise<SP> }) {
  const [user, t] = await Promise.all([requirePagePermission("penalties.view"), getT()]);
  const sp = await searchParams;
  const status = sp.status === undefined ? "PROPOSED" : sp.status;
  const canManage = hasPermission(user, "penalties.manage");
  const today = todayKey(user.settings.timezone);
  const [result, people, rules] = await Promise.all([
    listViolations(user, { status, userId: sp.userId || undefined, month: sp.month || undefined, page: sp.page }),
    canManage ? violationPeople(user) : Promise.resolve([]),
    canManage ? listPenaltyRules(user, { activeOnly: true }) : Promise.resolve([]),
  ]);
  const qs = (page: number) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...sp, status })) if (v && k !== "page") p.set(k, v);
    p.set("page", String(page));
    return `/penalties?${p}`;
  };
  const s = result.summary;
  return (
    <>
      <PageHeader
        title={t("penalties.title")}
        description={t("penalties.text")}
        actions={
          <>
            <Link href="/penalties/rules" className={buttonClasses("ghost", "sm")}>
              <ListChecks className="h-4 w-4" /> {t("penalties.rulesLink")}
            </Link>
            {canManage && <FindViolations from={`${today.slice(0, 7)}-01` > addDaysToKey(today, -1) ? addDaysToKey(today, -1) : `${today.slice(0, 7)}-01`} to={today} />}
            {canManage && <RecordViolation people={people} rules={rules.filter((r) => r.trigger === "MANUAL")} today={today} />}
          </>
        }
      />
      <Card className="mb-4 p-4">
        <form method="get" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-[12rem_1fr_10rem_auto]">
          <select name="status" defaultValue={status} aria-label={t("penalties.status")} className={control}>
            <option value="">{t("penalties.allStatuses")}</option>
            {VIOLATION_STATUSES.map((x) => (
              <option key={x} value={x}>
                {t(`penalties.statuses.${x}`)}
              </option>
            ))}
          </select>
          {canManage ? (
            <select name="userId" defaultValue={sp.userId ?? ""} aria-label={t("penalties.employee")} className={control}>
              <option value="">{t("penalties.allEmployees")}</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          ) : (
            <span />
          )}
          <input type="month" name="month" defaultValue={sp.month} aria-label={t("penalties.month")} className={control} />
          <button type="submit" className={submitBtn}>
            {t("common.show")}
          </button>
        </form>
      </Card>
      <Card className="overflow-hidden">
        <p className="border-b border-line px-4 py-2 text-xs text-fg-muted">
          {t("penalties.summary.proposed", { count: s.proposed })} ·{" "}
          {t("penalties.summary.approved", { warnings: s.approvedWarnings, deductions: s.approvedDeductions, amount: money(s.approvedAmount, t.locale) })}
        </p>
        <ViolationTable rows={result.rows} t={t} empty={t("penalties.empty")} />
        {result.pageCount > 1 && <Pagination page={result.page} pageCount={result.pageCount} total={result.total} hrefFor={qs} />}
      </Card>
    </>
  );
}
