import Link from "next/link";
import { BarChart3, Download, PieChart, UserCheck, Users, Wrench } from "lucide-react";
import { BarList, DailyColumns, StatTile } from "@/components/reports/charts";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Alert, PageHeader } from "@/components/ui/misc";
import { addDaysToKey, addMonthsToKey, formatKey, isValidDateString, startOfMonthKey, todayKey } from "@/lib/time";
import { requirePagePermission } from "@/server/auth/session";
import { buildReport } from "@/server/services/reports";
import { cn } from "@/lib/utils";

export const metadata = { title: "Reports" };

function exportLink(type: string, from: string, to: string) {
  return `/api/reports/export?type=${type}&from=${from}&to=${to}`;
}

function ExportButton({ type, from, to, label = "CSV" }: { type: string; from: string; to: string; label?: string }) {
  return (
    <a href={exportLink(type, from, to)} className={buttonClasses("ghost", "sm")}>
      <Download className="h-3.5 w-3.5" /> {label}
    </a>
  );
}

export default async function ReportsPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const user = await requirePagePermission("reports.view");
  const sp = await searchParams;
  const tz = user.settings.timezone;
  const today = todayKey(tz);
  const monthStart = startOfMonthKey(today);
  let from = sp.from && isValidDateString(sp.from) ? sp.from : monthStart;
  let to = sp.to && isValidDateString(sp.to) ? sp.to : addDaysToKey(addMonthsToKey(monthStart, 1), -1);
  let rangeError: string | null = null;
  if (from > to) {
    rangeError = "The start date was after the end date, so the dates were swapped.";
    [from, to] = [to, from];
  }
  const r = await buildReport(user, { from, to });

  const presets = [
    { label: "This month", from: monthStart, to: addDaysToKey(addMonthsToKey(monthStart, 1), -1) },
    { label: "Last month", from: addMonthsToKey(monthStart, -1), to: addDaysToKey(monthStart, -1) },
    { label: "Last 30 days", from: addDaysToKey(today, -29), to: today },
    { label: "Next 30 days", from: today, to: addDaysToKey(today, 29) },
    { label: "This year", from: `${today.slice(0, 4)}-01-01`, to: `${today.slice(0, 4)}-12-31` },
  ];
  const closed = r.completed + r.cancelled;
  // Every day (or month, for long ranges) gets a column - empty periods show as zero, so the
  // time axis stays honest.
  const counts = new Map(r.daily.map((d) => [d.day, d.count]));
  const spanDays = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
  const monthly = spanDays > 62;
  const buckets: { day: string; count: number }[] = [];
  if (monthly) {
    for (let m = startOfMonthKey(from); m <= to; m = addMonthsToKey(m, 1)) {
      const key = m.slice(0, 7);
      let n = 0;
      for (const [d, c] of counts) if (d.startsWith(key)) n += c;
      buckets.push({ day: m, count: n });
    }
  } else {
    for (let d = from; d <= to; d = addDaysToKey(d, 1)) buckets.push({ day: d, count: counts.get(d) ?? 0 });
  }
  const bucketLabel = (d: string) => (monthly ? formatKey(d, { month: "short", year: "numeric" }) : formatKey(d, { weekday: "short", day: "numeric", month: "short" }));

  return (
    <>
      <PageHeader
        title="Reports"
        description={`${formatKey(from, { day: "numeric", month: "long", year: "numeric" })} – ${formatKey(to, { day: "numeric", month: "long", year: "numeric" })} · by appointment date`}
        actions={
          <a href={exportLink("appointments", from, to)} className={buttonClasses("outline")}>
            <Download className="h-4 w-4" /> Export appointments (CSV)
          </a>
        }
      />

      <Card className="mb-6 p-4">
        <form method="get" className="flex flex-col gap-3 lg:flex-row lg:items-end">
          <div className="grid grid-cols-2 gap-3 sm:flex">
            <label className="text-xs font-medium text-fg-muted">
              From
              <input type="date" name="from" defaultValue={from} className="mt-1 block h-10 w-full rounded-lg border border-line-strong bg-surface px-2 text-sm text-fg" />
            </label>
            <label className="text-xs font-medium text-fg-muted">
              To
              <input type="date" name="to" defaultValue={to} className="mt-1 block h-10 w-full rounded-lg border border-line-strong bg-surface px-2 text-sm text-fg" />
            </label>
          </div>
          <button className={buttonClasses("primary")}>Apply</button>
          <div className="flex flex-wrap gap-1.5 lg:ml-auto">
            {presets.map((p) => {
              const active = p.from === from && p.to === to;
              return (
                <Link
                  key={p.label}
                  href={`/reports?from=${p.from}&to=${p.to}`}
                  className={cn(
                    "rounded-full border px-3 py-1.5 text-xs font-medium",
                    active ? "border-brand bg-brand-soft text-brand-text" : "border-line text-fg-muted hover:bg-surface-muted",
                  )}
                >
                  {p.label}
                </Link>
              );
            })}
          </div>
        </form>
      </Card>

      {rangeError && <Alert tone="info" className="mb-6">{rangeError}</Alert>}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="Appointments" value={r.total} sub="In the selected period" />
        <StatTile label="Completed" value={r.completed} />
        <StatTile label="Cancelled" value={r.cancelled} />
        <StatTile label="Completion rate" value={closed ? `${Math.round((r.completed / closed) * 100)}%` : "—"} sub="Completed vs. completed + cancelled" />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Card className="xl:col-span-2">
          <CardHeader title={monthly ? "Appointments per month" : "Appointments per day"} icon={<BarChart3 className="h-4 w-4" />} actions={<ExportButton type="daily" from={from} to={to} />} />
          <CardBody>
            <DailyColumns days={buckets} labelFor={bucketLabel} />
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="By status" icon={<PieChart className="h-4 w-4" />} actions={<ExportButton type="status" from={from} to={to} />} />
          <CardBody>
            <BarList rows={r.byStatus.map((s) => ({ key: s.id, label: s.name, value: s.count, color: s.color }))} />
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="By Sales employee" description="Colour = the employee's calendar colour" icon={<UserCheck className="h-4 w-4" />} actions={<ExportButton type="sales" from={from} to={to} />} />
          <CardBody>
            <BarList rows={r.bySales.map((s) => ({ key: s.id, label: `${s.name}${s.isActive ? "" : " (inactive)"}`, value: s.count, color: s.color }))} />
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="By installation category" icon={<Wrench className="h-4 w-4" />} actions={<ExportButton type="categories" from={from} to={to} />} />
          <CardBody>
            <BarList rows={r.byCategory.map((c) => ({ key: c.category, label: c.label, value: c.count }))} />
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Technician workload" description="Scheduled hours, excluding cancelled jobs" icon={<Users className="h-4 w-4" />} actions={<ExportButton type="technicians" from={from} to={to} />} />
          <CardBody className="space-y-4">
            <BarList rows={r.byTechnician.map((t) => ({ key: t.id, label: `${t.name}${t.isActive ? "" : " (inactive)"}`, value: t.minutes / 60, display: (t.minutes / 60).toFixed(1) }))} unit=" h" />
            {r.byTechnician.length > 0 && (
              <div className="overflow-x-auto rounded-lg border border-line">
                <table className="w-full text-xs">
                  <thead className="bg-surface-muted/60 text-fg-subtle">
                    <tr>
                      <th className="px-3 py-2 text-left font-semibold">Technician</th>
                      <th className="px-3 py-2 text-right font-semibold">Jobs</th>
                      <th className="px-3 py-2 text-right font-semibold">Completed</th>
                      <th className="px-3 py-2 text-right font-semibold">Cancelled</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {r.byTechnician.map((t) => (
                      <tr key={t.id}>
                        <td className="px-3 py-1.5">{t.name}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{t.jobs}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{t.completed}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{t.cancelled}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardBody>
        </Card>
      </div>
    </>
  );
}
