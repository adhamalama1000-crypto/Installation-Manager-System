import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { CalendarCheck2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { EmptyState, PageHeader } from "@/components/ui/misc";
import { getT } from "@/i18n/server";
import { formatKey } from "@/lib/time";
import { requireUser } from "@/server/auth/session";
import { attendance } from "@/server/services/field";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("nav.attendance") };
}

export default async function AttendancePage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const [user, t] = await Promise.all([requireUser(), getT()]);
  const all = user.permissions.includes("attendance.view");
  // Technicians (check-ins) and the driver (car check-ins) see their own month, as the service allows.
  if (!all && !user.permissions.includes("checkins.record") && !user.permissions.includes("car.checkin")) redirect("/access-denied");
  const sp = await searchParams;
  const data = await attendance(user, sp.month);
  const L = t.locale;
  const day = (k: string) => formatKey(k, { day: "numeric", month: "short" }, L);
  const dash = "—";
  const columns: { key: string; label: string; value: (r: (typeof data.rows)[number]) => React.ReactNode }[] = [
    { key: "points", label: t("attendance.points"), value: (r) => <span className="font-semibold text-fg">{r.points}</span> },
    { key: "days", label: t("attendance.days"), value: (r) => r.days },
    { key: "in", label: t("attendance.avgIn"), value: (r) => <bdi>{r.avgIn ?? dash}</bdi> },
    { key: "out", label: t("attendance.avgOut"), value: (r) => <bdi>{r.avgOut ?? dash}</bdi> },
    { key: "late", label: t("attendance.late"), value: (r) => (r.lateDays ? t("attendance.lateValue", { days: r.lateDays, minutes: r.lateMinutes }) : 0) },
    { key: "early", label: t("attendance.early"), value: (r) => r.earlyLeaves },
    { key: "leave", label: t("attendance.leave"), value: (r) => `${r.leaveDays} / ${r.sickDays}` },
    { key: "absent", label: t("attendance.absent"), value: (r) => (r.absences ? <span title={r.absentDates.map(day).join("، ")} className="text-danger">{r.absences}</span> : 0) },
    { key: "visits", label: t("attendance.visits"), value: (r) => `${r.done} / ${r.visits}` },
    { key: "onTime", label: t("attendance.onTime"), value: (r) => (r.arrived ? `${r.onTime} / ${r.arrived}` : dash) },
    { key: "rating", label: t("attendance.rating"), value: (r) => r.ratingAvg ?? dash },
    { key: "grade", label: t("attendance.grade"), value: (r) => r.gradeAvg ?? dash },
    { key: "revisits", label: t("attendance.revisits"), value: (r) => r.revisits },
    { key: "complaints", label: t("attendance.complaints"), value: (r) => r.complaints },
    { key: "duration", label: t("attendance.duration"), value: (r) => (r.avgVisitMinutes !== null ? t("attendance.minutes", { minutes: r.avgVisitMinutes }) : dash) },
  ];
  return (
    <>
      <PageHeader title={all ? t("attendance.title") : t("attendance.myTitle")} description={t("attendance.text")} />
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
      <Card>
        {data.rows.length === 0 ? (
          <EmptyState title={t("attendance.none")} icon={<CalendarCheck2 className="h-6 w-6" />} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[960px] text-sm">
              <caption className="sr-only">{t("attendance.title")}</caption>
              <thead className="border-b border-line bg-surface-muted text-xs text-fg-muted">
                <tr>
                  <th scope="col" className="px-4 py-3 text-start font-medium">
                    {t("common.technician")}
                  </th>
                  {columns.map((c) => (
                    <th key={c.key} scope="col" className="px-3 py-3 text-start font-medium">
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.rows.map((r) => (
                  <tr key={r.technician.id}>
                    <th scope="row" className="px-4 py-3 text-start font-medium text-fg">
                      {r.technician.name}
                    </th>
                    {columns.map((c) => (
                      <td key={c.key} className="px-3 py-3 tabular-nums text-fg-muted">
                        {c.value(r)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="border-t border-line px-5 py-3 text-xs text-fg-subtle">{t("attendance.pointsRule")}</p>
      </Card>
    </>
  );
}
