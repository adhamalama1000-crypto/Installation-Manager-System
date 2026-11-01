import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { ExpensesManager } from "@/components/expenses/expenses-manager";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/misc";
import { getT } from "@/i18n/server";
import { shortDate } from "@/lib/format";
import { requireUser } from "@/server/auth/session";
import { recentVisitsFor, listExpenses } from "@/server/services/expenses";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("nav.expenses") };
}

export default async function ExpensesPage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const [user, t] = await Promise.all([requireUser(), getT()]);
  const canRecord = user.permissions.includes("expenses.record");
  if (!canRecord && !user.permissions.includes("expenses.pay")) redirect("/access-denied");
  const sp = await searchParams;
  const tz = user.settings.timezone;
  const [data, visits] = await Promise.all([listExpenses(user, sp.month), canRecord ? recentVisitsFor(user) : Promise.resolve([])]);
  return (
    <>
      <PageHeader title={t("expenses.title")} description={data.canPay ? t("expenses.textPay") : t("expenses.text")} />
      <Card className="mb-4 p-4">
        <form method="get" className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1.5 text-sm font-medium text-fg">
            {t("attendance.month")}
            <input type="month" name="month" defaultValue={data.month} className="h-10 rounded-lg border border-line-strong bg-surface px-3 text-sm text-fg" />
          </label>
          <button type="submit" className="h-10 rounded-lg bg-brand-strong px-4 text-sm font-semibold text-white hover:bg-brand-stronger">
            {t("attendance.show")}
          </button>
        </form>
      </Card>
      <ExpensesManager
        data={data}
        canRecord={canRecord}
        visits={visits.map((v) => ({ id: v.id, label: `${shortDate(v.startsAt, tz, t.locale)} · ${v.customerName} · ${v.code}` }))}
      />
    </>
  );
}
