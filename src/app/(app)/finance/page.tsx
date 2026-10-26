import Link from "next/link";
import { ChevronLeft, ChevronRight, Download } from "lucide-react";
import { CashHoldings } from "@/components/finance/cash-holdings";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Alert, EmptyState, PageHeader } from "@/components/ui/misc";
import { PAYMENT_METHOD_LABELS, money } from "@/lib/constants";
import { addMonthsToKey, formatKey } from "@/lib/time";
import { requirePagePermission } from "@/server/auth/session";
import { financeStatement, parseMonth } from "@/server/services/payments";

export const metadata = { title: "Finance" };

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-line bg-surface p-4 shadow-card">
      <p className="text-sm text-fg-muted">{label}</p>
      <p className="mt-1 truncate text-xl font-semibold tabular-nums text-fg sm:text-2xl">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-fg-subtle">{sub}</p>}
    </div>
  );
}

function MethodList({ rows }: { rows: { method: keyof typeof PAYMENT_METHOD_LABELS; amount: number }[] }) {
  if (!rows.length) return <p className="px-5 py-4 text-sm text-fg-subtle">Nothing recorded.</p>;
  return (
    <ul className="divide-y divide-line">
      {rows.map((r) => (
        <li key={r.method} className="flex items-center justify-between px-5 py-2.5 text-sm">
          <span className="text-fg-muted">{PAYMENT_METHOD_LABELS[r.method]}</span>
          <span className="font-medium tabular-nums text-fg">{money(r.amount)}</span>
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
  const f = await financeStatement(user, month);
  const label = formatKey(`${month}-01`, { month: "long", year: "numeric" });
  const step = (n: number) => `/finance?month=${addMonthsToKey(`${month}-01`, n).slice(0, 7)}`;

  return (
    <>
      <PageHeader
        title="Finance"
        description="Visits of the month by visit date (cancelled visits excluded). Cash with technicians is the current total."
        actions={
          <>
            <Link href={step(-1)} className={buttonClasses("outline", "sm")} aria-label="Previous month">
              <ChevronLeft className="h-4 w-4" />
            </Link>
            <form method="get" className="flex items-center gap-2">
              <input
                type="month"
                name="month"
                defaultValue={month}
                aria-label="Month"
                className="h-8 rounded-lg border border-line-strong bg-surface px-2 text-sm text-fg"
              />
              <button className={buttonClasses("outline", "sm")}>Show</button>
            </form>
            <Link href={step(1)} className={buttonClasses("outline", "sm")} aria-label="Next month">
              <ChevronRight className="h-4 w-4" />
            </Link>
            <a href={`/api/finance/export?month=${month}`} className={buttonClasses("primary", "sm")}>
              <Download className="h-3.5 w-3.5" /> CSV
            </a>
          </>
        }
      />
      <h2 className="mb-3 text-lg font-semibold text-fg">{label}</h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <Tile label="Booked value" value={money(f.totalSales)} sub={`${f.visits} visit${f.visits === 1 ? "" : "s"}`} />
        <Tile label="Deposits" value={money(f.deposits)} />
        <Tile label="Collected at visits" value={money(f.collected)} />
        <Tile label="Extra fees" value={money(f.fees)} sub="Included in what customers owe" />
        <Tile label="Still owed by customers" value={money(f.owedTotal)} sub={`${f.owedCount} completed visit${f.owedCount === 1 ? "" : "s"}`} />
        <Tile label="Cash with technicians" value={money(f.cashHeld)} sub="Right now, all months" />
      </div>
      {f.unpriced > 0 && (
        <Alert tone="info" className="mt-4">
          {f.unpriced} completed visit{f.unpriced === 1 ? " has" : "s have"} no price recorded and {f.unpriced === 1 ? "is" : "are"} not counted.
        </Alert>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card className="overflow-hidden">
          <CardHeader title="Deposits by method" />
          <MethodList rows={f.depositsByMethod} />
        </Card>
        <Card className="overflow-hidden">
          <CardHeader title="Collected at visits by method" />
          <MethodList rows={f.collectedByMethod} />
        </Card>
      </div>

      <div className="mt-6">
        <CashHoldings holdings={f.holdings} entries={f.heldEntries} canReceive={f.canReceive} tz={tz} />
      </div>

      <Card className="mt-6 overflow-hidden">
        <CardHeader title="Customers who still owe" description="Completed visits of the month where less was collected than was due." />
        {f.owed.length === 0 ? (
          <EmptyState title="Nothing owed for this month." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-surface-muted/60 text-left text-xs uppercase tracking-wide text-fg-muted">
                <tr>
                  <th className="px-4 py-2 font-medium">Appointment</th>
                  <th className="px-4 py-2 font-medium">Customer</th>
                  <th className="px-4 py-2 font-medium">Sales</th>
                  <th className="px-4 py-2 text-right font-medium">Due</th>
                  <th className="px-4 py-2 text-right font-medium">Collected</th>
                  <th className="px-4 py-2 text-right font-medium">Owed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {f.owed.map((o) => (
                  <tr key={o.id}>
                    <td className="px-4 py-2">
                      <Link href={`/appointments/${o.id}`} prefetch={false} className="font-mono text-brand-text hover:underline">
                        {o.code}
                      </Link>
                      <span className="block text-xs text-fg-subtle">{formatKey(o.date, { day: "numeric", month: "short" })}</span>
                    </td>
                    <td className="px-4 py-2">
                      {o.customerName}
                      {o.phone && <span className="block text-xs text-fg-subtle">{o.phone}</span>}
                    </td>
                    <td className="px-4 py-2 text-fg-muted">{o.salesName}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{money(o.due)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{money(o.collected)}</td>
                    <td className="px-4 py-2 text-right font-medium tabular-nums text-danger">{money(o.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {f.owedCount > f.owed.length && <p className="px-4 py-3 text-xs text-fg-subtle">Showing the {f.owed.length} largest of {f.owedCount}. The CSV has all of them.</p>}
          </div>
        )}
      </Card>
    </>
  );
}
