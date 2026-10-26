import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft, ChevronRight, Download } from "lucide-react";
import { CashHoldings } from "@/components/finance/cash-holdings";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Ltr } from "@/components/ui/ltr";
import { Alert, EmptyState, PageHeader } from "@/components/ui/misc";
import { getI18n, type ServerI18n } from "@/i18n/server";
import type { PaymentMethod } from "@prisma/client";
import { addMonthsToKey } from "@/lib/time";
import { requirePagePermission } from "@/server/auth/session";
import { financeStatement, parseMonth } from "@/server/services/payments";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getI18n()).t("fin.title") };
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

function MethodList({ rows, i18n }: { rows: { method: PaymentMethod; amount: number }[]; i18n: ServerI18n }) {
  if (!rows.length) return <p className="px-5 py-4 text-sm text-fg-subtle">{i18n.t("fin.nothing")}</p>;
  return (
    <ul className="divide-y divide-line">
      {rows.map((r) => (
        <li key={r.method} className="flex items-center justify-between px-5 py-2.5 text-sm">
          <span className="text-fg-muted">{i18n.label("paymentMethod", r.method)}</span>
          <span className="font-medium tabular-nums text-fg">{i18n.f.money(r.amount)}</span>
        </li>
      ))}
    </ul>
  );
}

export default async function FinancePage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const user = await requirePagePermission("finance.view");
  const sp = await searchParams;
  const tz = user.settings.timezone;
  const month = parseMonth(sp.month, tz);
  const s = await financeStatement(user, month);
  const i18n = await getI18n();
  const { t, f } = i18n;
  const money = f.money;
  const step = (n: number) => `/finance?month=${addMonthsToKey(`${month}-01`, n).slice(0, 7)}`;

  return (
    <>
      <PageHeader
        title={t("fin.title")}
        description={t("fin.desc")}
        actions={
          <>
            <Link href={step(-1)} className={buttonClasses("outline", "sm")} aria-label={t("fin.previousMonth")}>
              <ChevronLeft className="h-4 w-4 rtl:-scale-x-100" />
            </Link>
            <form method="get" className="flex items-center gap-2">
              <input
                type="month"
                name="month"
                defaultValue={month}
                aria-label={t("fin.month")}
                className="h-8 rounded-lg border border-line-strong bg-surface px-2 text-sm text-fg"
              />
              <button className={buttonClasses("outline", "sm")}>{t("fin.show")}</button>
            </form>
            <Link href={step(1)} className={buttonClasses("outline", "sm")} aria-label={t("fin.nextMonth")}>
              <ChevronRight className="h-4 w-4 rtl:-scale-x-100" />
            </Link>
            <a href={`/api/finance/export?month=${month}`} className={buttonClasses("primary", "sm")}>
              <Download className="h-3.5 w-3.5" /> {t("fin.csv")}
            </a>
          </>
        }
      />
      <h2 className="mb-3 text-lg font-semibold text-fg">{f.month(month)}</h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <Tile label={t("fin.booked")} value={money(s.totalSales)} sub={t("common.visitsCount", { count: s.visits })} />
        <Tile label={t("fin.deposits")} value={money(s.deposits)} />
        <Tile label={t("fin.collected")} value={money(s.collected)} />
        <Tile label={t("fin.fees")} value={money(s.fees)} sub={t("fin.feesSub")} />
        <Tile label={t("fin.owed")} value={money(s.owedTotal)} sub={t("fin.owedSub", { count: s.owedCount })} />
        <Tile label={t("fin.cashHeld")} value={money(s.cashHeld)} sub={t("fin.cashHeldSub")} />
      </div>
      {s.unpriced > 0 && (
        <Alert tone="info" className="mt-4">
          {t("fin.unpriced", { count: s.unpriced })}
        </Alert>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card className="overflow-hidden">
          <CardHeader title={t("fin.depositsByMethod")} />
          <MethodList rows={s.depositsByMethod} i18n={i18n} />
        </Card>
        <Card className="overflow-hidden">
          <CardHeader title={t("fin.collectedByMethod")} />
          <MethodList rows={s.collectedByMethod} i18n={i18n} />
        </Card>
      </div>

      <div className="mt-6">
        <CashHoldings holdings={s.holdings} entries={s.heldEntries} canReceive={s.canReceive} />
      </div>

      <Card className="mt-6 overflow-hidden">
        <CardHeader title={t("fin.owedTitle")} description={t("fin.owedDesc")} />
        {s.owed.length === 0 ? (
          <EmptyState title={t("fin.nothingOwed")} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-surface-muted/60 text-start text-xs uppercase tracking-wide text-fg-muted">
                <tr>
                  <th className="px-4 py-2 text-start font-medium">{t("fin.colAppointment")}</th>
                  <th className="px-4 py-2 text-start font-medium">{t("fin.colCustomer")}</th>
                  <th className="px-4 py-2 text-start font-medium">{t("fin.colSales")}</th>
                  <th className="px-4 py-2 text-end font-medium">{t("fin.colDue")}</th>
                  <th className="px-4 py-2 text-end font-medium">{t("fin.colCollected")}</th>
                  <th className="px-4 py-2 text-end font-medium">{t("fin.colOwed")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {s.owed.map((o) => (
                  <tr key={o.id}>
                    <td className="px-4 py-2">
                      <Link href={`/appointments/${o.id}`} prefetch={false} className="font-mono text-brand-text hover:underline">
                        <Ltr>{o.code}</Ltr>
                      </Link>
                      <span className="block text-xs text-fg-subtle">{f.day(o.date, { day: "numeric", month: "short" })}</span>
                    </td>
                    <td className="px-4 py-2">
                      {o.customerName}
                      {o.phone && (
                        <span className="block text-xs text-fg-subtle">
                          <Ltr>{o.phone}</Ltr>
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-fg-muted">{o.salesName}</td>
                    <td className="px-4 py-2 text-end tabular-nums">{money(o.due)}</td>
                    <td className="px-4 py-2 text-end tabular-nums">{money(o.collected)}</td>
                    <td className="px-4 py-2 text-end font-medium tabular-nums text-danger">{money(o.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {s.owedCount > s.owed.length && <p className="px-4 py-3 text-xs text-fg-subtle">{t("fin.showingLargest", { shown: s.owed.length, total: s.owedCount })}</p>}
          </div>
        )}
      </Card>
    </>
  );
}
