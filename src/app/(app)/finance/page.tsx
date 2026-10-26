import Link from "next/link";
import { ChevronLeft, ChevronRight, Download } from "lucide-react";
import { CashHoldings } from "@/components/finance/cash-holdings";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Alert, EmptyState, PageHeader } from "@/components/ui/misc";
import type { PaymentMethod } from "@prisma/client";
import { getT } from "@/i18n/server";
import type { T } from "@/i18n/translator";
import type { Metadata } from "next";
import { money } from "@/lib/constants";
import { addMonthsToKey, formatKey } from "@/lib/time";
import { requirePagePermission } from "@/server/auth/session";
import { financeStatement, parseMonth } from "@/server/services/payments";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("nav.finance") };
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-line bg-surface p-4 shadow-card">
      <p className="text-sm text-fg-muted">{label}</p>
      <p className="mt-1 truncate text-xl font-semibold tabular-nums text-fg sm:text-2xl">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-fg-subtle">{sub}</p>}
    </div>
  );
}

function MethodList({ rows, t }: { rows: { method: PaymentMethod; amount: number }[]; t: T }) {
  if (!rows.length) return <p className="px-5 py-4 text-sm text-fg-subtle">{t("finance.nothing")}</p>;
  return (
    <ul className="divide-y divide-line">
      {rows.map((r) => (
        <li key={r.method} className="flex items-center justify-between px-5 py-2.5 text-sm">
          <span className="text-fg-muted">{t.dyn(`enums.paymentMethod.${r.method}`)}</span>
          <span className="font-medium tabular-nums text-fg">{money(r.amount, t.locale)}</span>
        </li>
      ))}
    </ul>
  );
}

export default async function FinancePage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const [user, t] = await Promise.all([requirePagePermission("finance.view"), getT()]);
  const egp = (n: number | null | undefined) => money(n, t.locale);
  const sp = await searchParams;
  const tz = user.settings.timezone;
  const month = parseMonth(sp.month, tz);
  const f = await financeStatement(user, month);
  const label = formatKey(`${month}-01`, { month: "long", year: "numeric" }, t.locale);
  const step = (n: number) => `/finance?month=${addMonthsToKey(`${month}-01`, n).slice(0, 7)}`;

  return (
    <>
      <PageHeader
        title={t("nav.finance")}
        description={t("finance.text")}
        actions={
          <>
            <Link href={step(-1)} className={buttonClasses("outline", "sm")} aria-label={t("finance.prevMonth")}>
              <ChevronLeft className="h-4 w-4 rtl:rotate-180" />
            </Link>
            <form method="get" className="flex items-center gap-2">
              <input
                type="month"
                name="month"
                defaultValue={month}
                aria-label={t("calendar.month")}
                className="h-8 rounded-lg border border-line-strong bg-surface px-2 text-sm text-fg"
              />
              <button className={buttonClasses("outline", "sm")}>{t("common.show")}</button>
            </form>
            <Link href={step(1)} className={buttonClasses("outline", "sm")} aria-label={t("finance.nextMonth")}>
              <ChevronRight className="h-4 w-4 rtl:rotate-180" />
            </Link>
            <a href={`/api/finance/export?month=${month}`} className={buttonClasses("primary", "sm")}>
              <Download className="h-3.5 w-3.5" /> CSV
            </a>
          </>
        }
      />
      <h2 className="mb-3 text-lg font-semibold text-fg">{label}</h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <Tile label={t("finance.booked")} value={egp(f.totalSales)} sub={t("common.visits", { count: f.visits })} />
        <Tile label={t("finance.deposits")} value={egp(f.deposits)} />
        <Tile label={t("finance.collected")} value={egp(f.collected)} />
        <Tile label={t("finance.fees")} value={egp(f.fees)} sub={t("finance.feesSub")} />
        <Tile label={t("finance.owed")} value={egp(f.owedTotal)} sub={t("finance.completedVisits", { count: f.owedCount })} />
        <Tile label={t("finance.cashHeld")} value={egp(f.cashHeld)} sub={t("finance.cashHeldSub")} />
      </div>
      {f.unpriced > 0 && (
        <Alert tone="info" className="mt-4">
          {t("finance.unpriced", { count: f.unpriced })}
        </Alert>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card className="overflow-hidden">
          <CardHeader title={t("finance.depositsByMethod")} />
          <MethodList rows={f.depositsByMethod} t={t} />
        </Card>
        <Card className="overflow-hidden">
          <CardHeader title={t("finance.collectedByMethod")} />
          <MethodList rows={f.collectedByMethod} t={t} />
        </Card>
      </div>

      <div className="mt-6">
        <CashHoldings holdings={f.holdings} entries={f.heldEntries} canReceive={f.canReceive} tz={tz} />
      </div>

      <Card className="mt-6 overflow-hidden">
        <CardHeader title={t("finance.owedTitle")} description={t("finance.owedText")} />
        {f.owed.length === 0 ? (
          <EmptyState title={t("finance.nothingOwed")} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-surface-muted/60 text-start text-xs uppercase tracking-wide text-fg-muted">
                <tr>
                  <th className="px-4 py-2 text-start font-medium">{t("csv.appointment")}</th>
                  <th className="px-4 py-2 text-start font-medium">{t("common.customer")}</th>
                  <th className="px-4 py-2 text-start font-medium">{t("common.sales")}</th>
                  <th className="px-4 py-2 text-end font-medium">{t("finance.due")}</th>
                  <th className="px-4 py-2 text-end font-medium">{t("csv.collected")}</th>
                  <th className="px-4 py-2 text-end font-medium">{t("finance.owedCol")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {f.owed.map((o) => (
                  <tr key={o.id}>
                    <td className="px-4 py-2">
                      <Link href={`/appointments/${o.id}`} prefetch={false} className="font-mono text-brand-text hover:underline" dir="ltr">
                        {o.code}
                      </Link>
                      <span className="block text-xs text-fg-subtle">{formatKey(o.date, { day: "numeric", month: "short" }, t.locale)}</span>
                    </td>
                    <td className="px-4 py-2">
                      {o.customerName}
                      {o.phone && (
                        <span className="block text-xs text-fg-subtle" dir="ltr">
                          {o.phone}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-fg-muted">{o.salesName}</td>
                    <td className="px-4 py-2 text-end tabular-nums">{egp(o.due)}</td>
                    <td className="px-4 py-2 text-end tabular-nums">{egp(o.collected)}</td>
                    <td className="px-4 py-2 text-end font-medium tabular-nums text-danger">{egp(o.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {f.owedCount > f.owed.length && <p className="px-4 py-3 text-xs text-fg-subtle">{t("finance.showingLargest", { shown: f.owed.length, count: f.owedCount })}</p>}
          </div>
        )}
      </Card>
    </>
  );
}
