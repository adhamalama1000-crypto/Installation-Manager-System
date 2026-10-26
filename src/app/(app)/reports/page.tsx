import type { Metadata } from "next";
import Link from "next/link";
import { BarChart3, Download, PieChart, UserCheck, Users, Wrench } from "lucide-react";
import { BarList, DailyColumns, StatTile } from "@/components/reports/charts";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Alert, PageHeader } from "@/components/ui/misc";
import { getI18n } from "@/i18n/server";
import type { MessageKey } from "@/i18n/translate";
import { addDaysToKey, addMonthsToKey, isValidDateString, startOfMonthKey, todayKey } from "@/lib/time";
import { requirePagePermission } from "@/server/auth/session";
import { buildReport } from "@/server/services/reports";
import { cn } from "@/lib/utils";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getI18n()).t("rep.title") };
}

function exportLink(type: string, from: string, to: string) {
  return `/api/reports/export?type=${type}&from=${from}&to=${to}`;
}

function ExportButton({ type, from, to, label = "CSV" }: { type: string; from: string; to: string; label?: string }) {
  // "CSV" is a file format name, the same in both languages.
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
  const { t, f, label, sn } = await getI18n();
  const today = todayKey(tz);
  const monthStart = startOfMonthKey(today);
  let from = sp.from && isValidDateString(sp.from) ? sp.from : monthStart;
  let to = sp.to && isValidDateString(sp.to) ? sp.to : addDaysToKey(addMonthsToKey(monthStart, 1), -1);
  let rangeError: string | null = null;
  if (from > to) {
    rangeError = t("rep.swapped");
    [from, to] = [to, from];
  }
  const r = await buildReport(user, { from, to });

  const presets: { label: MessageKey; from: string; to: string }[] = [
    { label: "rep.thisMonth", from: monthStart, to: addDaysToKey(addMonthsToKey(monthStart, 1), -1) },
    { label: "rep.lastMonth", from: addMonthsToKey(monthStart, -1), to: addDaysToKey(monthStart, -1) },
    { label: "rep.last30", from: addDaysToKey(today, -29), to: today },
    { label: "rep.next30", from: today, to: addDaysToKey(today, 29) },
    { label: "rep.thisYear", from: `${today.slice(0, 4)}-01-01`, to: `${today.slice(0, 4)}-12-31` },
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
  const bucketLabel = (d: string) => (monthly ? f.day(d, { month: "short", year: "numeric" }) : f.day(d, { weekday: "short", day: "numeric", month: "short" }));
  const longDay = (d: string) => f.day(d, { day: "numeric", month: "long", year: "numeric" });

  return (
    <>
      <PageHeader
        title={t("rep.title")}
        description={t("rep.byDate", { from: longDay(from), to: longDay(to) })}
        actions={
          <a href={exportLink("appointments", from, to)} className={buttonClasses("outline")}>
            <Download className="h-4 w-4" /> {t("rep.exportAppointments")}
          </a>
        }
      />

      <Card className="mb-6 p-4">
        <form method="get" className="flex flex-col gap-3 lg:flex-row lg:items-end">
          <div className="grid grid-cols-2 gap-3 sm:flex">
            <label className="text-xs font-medium text-fg-muted">
              {t("common.from")}
              <input type="date" name="from" defaultValue={from} className="mt-1 block h-10 w-full rounded-lg border border-line-strong bg-surface px-2 text-sm text-fg" />
            </label>
            <label className="text-xs font-medium text-fg-muted">
              {t("common.to")}
              <input type="date" name="to" defaultValue={to} className="mt-1 block h-10 w-full rounded-lg border border-line-strong bg-surface px-2 text-sm text-fg" />
            </label>
          </div>
          <button className={buttonClasses("primary")}>{t("common.apply")}</button>
          <div className="flex flex-wrap gap-1.5 lg:ms-auto">
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
                  {t(p.label)}
                </Link>
              );
            })}
          </div>
        </form>
      </Card>

      {rangeError && <Alert tone="info" className="mb-6">{rangeError}</Alert>}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label={t("rep.appointments")} value={f.number(r.total)} sub={t("rep.inPeriod")} />
        <StatTile label={t("rep.completed")} value={f.number(r.completed)} />
        <StatTile label={t("rep.cancelled")} value={f.number(r.cancelled)} />
        <StatTile label={t("rep.rate")} value={closed ? `${Math.round((r.completed / closed) * 100)}%` : "—"} sub={t("rep.rateSub")} />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Card className="xl:col-span-2">
          <CardHeader title={monthly ? t("rep.perMonth") : t("rep.perDay")} icon={<BarChart3 className="h-4 w-4" />} actions={<ExportButton type="daily" from={from} to={to} />} />
          <CardBody>
            <DailyColumns
              days={buckets}
              labelFor={bucketLabel}
              columnLabel={(d, count) => t("rep.columnLabel", { label: bucketLabel(d), count })}
              emptyText={t("rep.noAppointments")}
            />
          </CardBody>
        </Card>

        <Card>
          <CardHeader title={t("rep.byStatus")} icon={<PieChart className="h-4 w-4" />} actions={<ExportButton type="status" from={from} to={to} />} />
          <CardBody>
            <BarList emptyText={t("rep.noData")} rows={r.byStatus.map((s) => ({ key: s.id, label: sn(s), value: s.count, color: s.color }))} />
          </CardBody>
        </Card>

        <Card>
          <CardHeader title={t("rep.bySales")} description={t("rep.bySalesDesc")} icon={<UserCheck className="h-4 w-4" />} actions={<ExportButton type="sales" from={from} to={to} />} />
          <CardBody>
            <BarList
              emptyText={t("rep.noData")}
              rows={r.bySales.map((s) => ({ key: s.id, label: `${s.name}${s.isActive ? "" : ` ${t("common.inactiveParen")}`}`, value: s.count, color: s.color }))}
            />
          </CardBody>
        </Card>

        <Card>
          <CardHeader title={t("rep.byCategory")} icon={<Wrench className="h-4 w-4" />} actions={<ExportButton type="categories" from={from} to={to} />} />
          <CardBody>
            <BarList emptyText={t("rep.noData")} rows={r.byCategory.map((c) => ({ key: c.category, label: label("category", c.category), value: c.count }))} />
          </CardBody>
        </Card>

        <Card>
          <CardHeader title={t("rep.workload")} description={t("rep.workloadDesc")} icon={<Users className="h-4 w-4" />} actions={<ExportButton type="technicians" from={from} to={to} />} />
          <CardBody className="space-y-4">
            <BarList
              emptyText={t("rep.noData")}
              rows={r.byTechnician.map((tech) => ({
                key: tech.id,
                label: `${tech.name}${tech.isActive ? "" : ` ${t("common.inactiveParen")}`}`,
                value: tech.minutes / 60,
                display: (tech.minutes / 60).toFixed(1),
              }))}
              unit={t("rep.hoursUnit")}
            />
            {r.byTechnician.length > 0 && (
              <div className="overflow-x-auto rounded-lg border border-line">
                <table className="w-full text-xs">
                  <thead className="bg-surface-muted/60 text-fg-subtle">
                    <tr>
                      <th className="px-3 py-2 text-start font-semibold">{t("rep.colTechnician")}</th>
                      <th className="px-3 py-2 text-end font-semibold">{t("rep.colJobs")}</th>
                      <th className="px-3 py-2 text-end font-semibold">{t("rep.colCompleted")}</th>
                      <th className="px-3 py-2 text-end font-semibold">{t("rep.colCancelled")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {r.byTechnician.map((tech) => (
                      <tr key={tech.id}>
                        <td className="px-3 py-1.5">{tech.name}</td>
                        <td className="px-3 py-1.5 text-end tabular-nums">{tech.jobs}</td>
                        <td className="px-3 py-1.5 text-end tabular-nums">{tech.completed}</td>
                        <td className="px-3 py-1.5 text-end tabular-nums">{tech.cancelled}</td>
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
