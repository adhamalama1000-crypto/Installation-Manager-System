import Link from "next/link";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Card, CardHeader } from "@/components/ui/card";
import { Badge, EmptyState, PageHeader } from "@/components/ui/misc";
import { ReviewButton } from "@/components/attendance/review-button";
import { WorkLocations } from "@/components/attendance/work-locations";
import { control, submitBtn, tableHead, th, thEnd } from "@/components/erp/labels";
import { getT } from "@/i18n/server";
import { addDaysToKey, formatKey, startOfMonthKey, timeKey, weekdayOfKey } from "@/lib/time";
import { hasPermission } from "@/server/access";
import { requireUser } from "@/server/auth/session";
import { attendanceRange, listWorkLocations, type AttendanceDayRow } from "@/server/services/attendance";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("clock.daily") };
}

type SP = { from?: string; to?: string; range?: string; issues?: string };

export default async function AttendanceDailyPage({ searchParams }: { searchParams: Promise<SP> }) {
  const [user, t] = await Promise.all([requireUser(), getT()]);
  const manager = hasPermission(user, "attendance.view") || hasPermission(user, "attendance.manage");
  if (!manager) redirect("/attendance/clock");
  const sp = await searchParams;
  const tz = user.settings.timezone;
  const L = t.locale;
  // Quick ranges: today, this week (from the configured first day), this month.
  const base = await attendanceRange(user, undefined, undefined);
  const today = base.today;
  const weekStart = (() => {
    let d = today;
    while (weekdayOfKey(d) !== user.settings.weekStartsOn) d = addDaysToKey(d, -1);
    return d;
  })();
  const range = sp.range === "week" ? { from: weekStart, to: today } : sp.range === "month" ? { from: startOfMonthKey(today), to: today } : { from: sp.from ?? today, to: sp.to ?? sp.from ?? today };
  const [data, locations] = await Promise.all([attendanceRange(user, range.from, range.to), hasPermission(user, "attendance.manage") ? listWorkLocations(user, true) : Promise.resolve(null)]);
  const day = (k: string) => formatKey(k, { weekday: "short", day: "numeric", month: "short" }, L);
  const time = (iso: string | undefined) => (iso ? timeKey(new Date(iso), tz) : "—");
  const hours = (m: number | null) => (m === null ? "—" : t("clock.hours", { hours: Math.floor(m / 60), minutes: m % 60 }));
  const issue = (r: AttendanceDayRow) => r.status === "absent" || r.missingCheckout || r.needsReview || !!r.clockIn?.flags.late || !!r.clockOut?.flags.early;
  const rows = sp.issues === "1" ? data.rows.filter(issue) : data.rows;
  const flagBadges = (r: AttendanceDayRow) => {
    const out: string[] = [];
    const ci = r.clockIn?.flags;
    const co = r.clockOut?.flags;
    if (ci?.late) out.push(`${t("clock.flags.late")} ${r.clockIn?.lateMinutes ?? ""}′`);
    if (co?.early) out.push(`${t("clock.flags.early")} ${r.clockOut?.earlyMinutes ?? ""}′`);
    if (ci?.outside || co?.outside) out.push(t("clock.flags.outside"));
    if (ci?.noLocation || co?.noLocation) out.push(t("clock.flags.noLocation"));
    if (ci?.lowAccuracy || co?.lowAccuracy) out.push(t("clock.flags.lowAccuracy"));
    if (r.missingCheckout) out.push(t("clock.flags.missingCheckout"));
    return out;
  };
  const map = (x: { latitude: number | null; longitude: number | null } | null) =>
    x && x.latitude !== null ? (
      <a href={`https://www.google.com/maps?q=${x.latitude},${x.longitude}`} target="_blank" rel="noopener noreferrer" className="text-xs text-brand-text hover:underline">
        {t("clock.map")}
      </a>
    ) : null;
  return (
    <>
      <PageHeader
        title={t("clock.daily")}
        description={t("clock.dailyText")}
        actions={
          <Link href="/attendance" className="text-sm font-medium text-brand-text hover:underline">
            {t("nav.attendance")}
          </Link>
        }
      />
      <Card className="mb-4 p-4">
        <form method="get" className="flex flex-wrap items-end gap-3">
          <div className="flex gap-2">
            {(["today", "week", "month"] as const).map((r) => (
              <Link key={r} href={`/attendance/daily?range=${r}${sp.issues ? "&issues=1" : ""}`} className={`rounded-lg border px-3 py-2 text-sm ${((sp.range ?? (sp.from ? "" : "today")) === r) ? "border-brand bg-brand-soft text-brand-text" : "border-line-strong"}`}>
                {t(r === "today" ? "clock.today" : r === "week" ? "clock.thisWeek" : "clock.thisMonth")}
              </Link>
            ))}
          </div>
          <input type="date" name="from" defaultValue={data.from} aria-label={t("analytics.from")} className={`${control} w-auto`} />
          <input type="date" name="to" defaultValue={data.to} aria-label={t("analytics.to")} className={`${control} w-auto`} />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="issues" value="1" defaultChecked={sp.issues === "1"} className="h-4 w-4 accent-[var(--brand-strong)]" /> {t("clock.onlyIssues")}
          </label>
          <button type="submit" className={submitBtn}>
            {t("analytics.apply")}
          </button>
        </form>
      </Card>

      {data.days.length > 1 && (
        <Card className="mb-4 overflow-hidden">
          <CardHeader title={t("clock.summary")} description={`${day(data.from)} – ${day(data.to)}`} />
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className={tableHead}>
                <tr>
                  <th className={th}>{t("clock.person")}</th>
                  <th className={thEnd}>{t("clock.present")}</th>
                  <th className={thEnd}>{t("clock.absent")}</th>
                  <th className={thEnd}>{t("clock.late")}</th>
                  <th className={thEnd}>{t("clock.early")}</th>
                  <th className={thEnd}>{t("clock.missing")}</th>
                  <th className={thEnd}>{t("clock.flagged")}</th>
                  <th className={thEnd}>{t("clock.totalWorked")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.summary.map((s) => (
                  <tr key={s.person.id}>
                    <td className="px-4 py-2 font-medium">{s.person.name}</td>
                    <td className="px-4 py-2 text-end tabular-nums">{s.present}</td>
                    <td className={`px-4 py-2 text-end tabular-nums ${s.absent ? "text-danger" : ""}`}>{s.absent}</td>
                    <td className="px-4 py-2 text-end tabular-nums">{s.late}</td>
                    <td className="px-4 py-2 text-end tabular-nums">{s.early}</td>
                    <td className="px-4 py-2 text-end tabular-nums">{s.missingCheckout}</td>
                    <td className="px-4 py-2 text-end tabular-nums">{s.flagged}</td>
                    <td className="px-4 py-2 text-end tabular-nums">{hours(s.workedMinutes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card className="mb-6 overflow-hidden">
        {rows.length === 0 ? (
          <EmptyState title={t("clock.noRows")} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[960px] text-sm">
              <thead className={tableHead}>
                <tr>
                  <th className={th}>{t("clock.person")}</th>
                  {data.days.length > 1 && <th className={th}>{t("clock.day")}</th>}
                  <th className={th}>{t("common.status")}</th>
                  <th className={th}>{t("clock.in_")}</th>
                  <th className={th}>{t("clock.out_")}</th>
                  <th className={thEnd}>{t("clock.worked")}</th>
                  <th className={th}>{t("clock.selfie")}</th>
                  <th className={th}>{t("attendance.visits")}</th>
                  <th className={th}>{t("clock.review")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((r) => (
                  <tr key={`${r.person.id}-${r.day}`} className={r.needsReview ? "bg-warning-soft/40 align-top" : "align-top"}>
                    <td className="px-4 py-2 font-medium">{r.person.name}</td>
                    {data.days.length > 1 && <td className="whitespace-nowrap px-4 py-2 text-fg-muted">{day(r.day)}</td>}
                    <td className="px-4 py-2">
                      <Badge className={r.status === "absent" ? "border-danger/40 bg-danger-soft text-danger" : r.status === "present" ? "border-success/40 bg-success-soft text-fg" : ""}>{t(`clock.status.${r.status}`)}</Badge>
                      <span className="mt-1 flex flex-wrap gap-1">
                        {flagBadges(r).map((f) => (
                          <Badge key={f} className="border-warning/40 bg-warning-soft text-fg">
                            {f}
                          </Badge>
                        ))}
                      </span>
                    </td>
                    <td className="px-4 py-2">
                      <bdi className="tabular-nums">{time(r.clockIn?.at)}</bdi>
                      {r.clockIn && (
                        <span className="block text-xs text-fg-muted">
                          {r.clockIn.site ? t(`clock.sites.${r.clockIn.site}`) : t("clock.sites.COMPANY")}
                          {r.clockIn.distanceM !== null && ` · ${r.clockIn.distanceM} m${r.clockIn.geofenceM ? ` / ${r.clockIn.geofenceM} m` : ""}`}
                          {r.clockIn.accuracyM !== null && ` · ±${r.clockIn.accuracyM} m`} {map(r.clockIn)}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      <bdi className="tabular-nums">{time(r.clockOut?.at)}</bdi>
                      {r.clockOut && (
                        <span className="block text-xs text-fg-muted">
                          {r.clockOut.distanceM !== null && `${r.clockOut.distanceM} m `}
                          {map(r.clockOut)}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-end tabular-nums">{hours(r.workedMinutes)}</td>
                    <td className="px-4 py-2">
                      <span className="flex gap-1">
                        {[r.clockIn, r.clockOut].map((c) =>
                          c?.selfieUrl ? (
                            <a key={c.id} href={c.selfieUrl} target="_blank" rel="noopener noreferrer">
                              {/* eslint-disable-next-line @next/next/no-img-element -- private, permission-checked photo */}
                              <img src={c.selfieUrl} alt={`${t("clock.selfie")} ${r.person.name}`} className="h-10 w-10 rounded border border-line object-cover" loading="lazy" />
                            </a>
                          ) : null,
                        )}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-xs">
                      {r.visits.map((v) => (
                        <Link key={v.id} prefetch={false} href={`/appointments/${v.id}`} className="block text-brand-text hover:underline">
                          {v.code} · {v.customerName}
                        </Link>
                      ))}
                    </td>
                    <td className="px-4 py-2 text-xs">
                      {r.review ? (
                        <span className={r.review.decision === "REJECTED" ? "text-danger" : "text-success"}>{r.review.decision === "ACCEPTED" ? t("clock.accepted", { name: r.review.by }) : t("clock.rejected", { name: r.review.by, note: r.review.note ?? "" })}</span>
                      ) : r.needsReview && data.canReview && (r.clockIn || r.clockOut) ? (
                        <ReviewButton checkInId={(r.clockIn ?? r.clockOut)!.id} label={`${r.person.name} · ${day(r.day)}`} />
                      ) : r.needsReview ? (
                        <span className="text-warning">{t("clock.needsReview")}</span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {locations && <WorkLocations rows={locations} />}
    </>
  );
}
