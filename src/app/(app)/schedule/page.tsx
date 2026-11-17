import Link from "next/link";
import type { Metadata } from "next";
import { CalendarDays, ChevronLeft, ChevronRight, Clock, EyeOff } from "lucide-react";
import { Card } from "@/components/ui/card";
import { buttonClasses } from "@/components/ui/button";
import { Badge, EmptyState, PageHeader, StatusBadge } from "@/components/ui/misc";
import { RescheduleQueue } from "@/components/schedule/reschedule";
import { getT } from "@/i18n/server";
import type { T } from "@/i18n/translator";
import { VISIT_TYPES } from "@/lib/constants";
import { addDaysToKey, addMonthsToKey, formatKey, isValidDateString, startOfWeekKey, todayKey } from "@/lib/time";
import type { StatusDTO } from "@/lib/types";
import { cn } from "@/lib/utils";
import { hasPermission } from "@/server/access";
import { requirePagePermission } from "@/server/auth/session";
import { prisma } from "@/server/db";
import { companySchedule, SCHEDULE_VIEWS, type CompanySchedule, type ScheduleDay, type ScheduleJob, type ScheduleView } from "@/server/services/company-schedule";
import { openRescheduleRequests } from "@/server/services/reschedule-requests";
import { listStatuses } from "@/server/services/statuses";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("companySchedule.title") };
}

type Search = { view?: string; date?: string; technicianId?: string; visitType?: string; statusId?: string };

/**
 * The company schedule (schedule.global): every technician's day, week or month, their working
 * hours, days off and leave, and how full they are. Read-only; customer details appear only on
 * visits the reader may already open. Managers (schedule.manage) also see open reschedule requests.
 */
export default async function CompanySchedulePage({ searchParams }: { searchParams: Promise<Search> }) {
  const [user, t] = await Promise.all([requirePagePermission("schedule.global"), getT()]);
  const sp = await searchParams;
  const tz = user.settings.timezone;
  const view: ScheduleView = (SCHEDULE_VIEWS as readonly string[]).includes(sp.view ?? "") ? (sp.view as ScheduleView) : "day";
  const date = sp.date && isValidDateString(sp.date) ? sp.date : todayKey(tz);
  const filters = { technicianId: sp.technicianId || null, visitType: sp.visitType || null, statusId: sp.statusId || null };
  const [data, statuses, requests, allTechs] = await Promise.all([
    companySchedule(user, { view, date, ...filters }),
    listStatuses(t.locale),
    hasPermission(user, "appointments.manage") ? openRescheduleRequests(user) : Promise.resolve([]),
    prisma.user.findMany({ where: { role: "TECHNICIAN", isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  const technicianOptions = allTechs;
  const statusById = new Map(statuses.map((s) => [s.id, s]));
  const href = (patch: Partial<Search>) => {
    const q = new URLSearchParams();
    const merged = { view, date, technicianId: filters.technicianId ?? "", visitType: filters.visitType ?? "", statusId: filters.statusId ?? "", ...patch };
    for (const [k, v] of Object.entries(merged)) if (v) q.set(k, v);
    return `/schedule?${q.toString()}`;
  };
  const step = (dir: 1 | -1) => (view === "month" ? addMonthsToKey(date, dir) : addDaysToKey(date, view === "week" ? 7 * dir : dir));
  const title =
    view === "month"
      ? formatKey(date, { month: "long", year: "numeric" }, t.locale)
      : view === "day"
        ? formatKey(date, { weekday: "long", day: "numeric", month: "long", year: "numeric" }, t.locale)
        : `${formatKey(data.from, { day: "numeric", month: "short" }, t.locale)} – ${formatKey(data.to, { day: "numeric", month: "short", year: "numeric" }, t.locale)}`;

  return (
    <>
      <PageHeader
        title={t("companySchedule.title")}
        description={t("companySchedule.text")}
        actions={
          <>
            <Link href="/calendar" className={buttonClasses("outline", "sm")}>
              <CalendarDays className="h-4 w-4" /> {user.role === "TECHNICIAN" ? t("nav.mySchedule") : t("nav.calendar")}
            </Link>
            {hasPermission(user, "schedule.manage") && (
              <Link href="/schedule/hours" className={buttonClasses("outline", "sm")}>
                <Clock className="h-4 w-4" /> {t("workHours.title")}
              </Link>
            )}
          </>
        }
      />

      {requests.length > 0 && <RescheduleQueue requests={requests} tz={tz} />}

      <Card className="mb-4 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <nav aria-label={t("companySchedule.views")} className="inline-flex rounded-lg border border-line p-0.5">
            {SCHEDULE_VIEWS.map((v) => (
              <Link key={v} href={href({ view: v })} aria-current={v === view ? "page" : undefined} className={cn("rounded-md px-3 py-1.5 text-sm", v === view ? "bg-brand-soft font-medium text-brand-text" : "text-fg-muted hover:text-fg")}>
                {t(`calendar.${v}`)}
              </Link>
            ))}
          </nav>
          <div className="flex items-center gap-1">
            <Link href={href({ date: step(-1) })} className={buttonClasses("ghost", "icon")} aria-label={t("companySchedule.previous")}>
              <ChevronLeft className="h-4 w-4 rtl:rotate-180" />
            </Link>
            <Link href={href({ date: todayKey(tz) })} className={buttonClasses("outline", "sm")}>
              {t("companySchedule.today")}
            </Link>
            <Link href={href({ date: step(1) })} className={buttonClasses("ghost", "icon")} aria-label={t("companySchedule.next")}>
              <ChevronRight className="h-4 w-4 rtl:rotate-180" />
            </Link>
          </div>
          <h2 className="text-base font-semibold text-fg">{title}</h2>
        </div>
        <form method="get" action="/schedule" className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
          <input type="hidden" name="view" value={view} />
          <input type="hidden" name="date" value={date} />
          <label className="text-sm">
            <span className="mb-1 block text-fg-muted">{t("companySchedule.technician")}</span>
            <select name="technicianId" defaultValue={filters.technicianId ?? ""} className="h-10 w-full rounded-lg border border-line bg-surface px-3 text-sm">
              <option value="">{t("companySchedule.allTechnicians")}</option>
              {technicianOptions.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-fg-muted">{t("companySchedule.jobType")}</span>
            <select name="visitType" defaultValue={filters.visitType ?? ""} className="h-10 w-full rounded-lg border border-line bg-surface px-3 text-sm">
              <option value="">{t("companySchedule.allJobTypes")}</option>
              {VISIT_TYPES.map((v) => (
                <option key={v} value={v}>
                  {t.dyn(`enums.visitType.${v}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-fg-muted">{t("companySchedule.status")}</span>
            <select name="statusId" defaultValue={filters.statusId ?? ""} className="h-10 w-full rounded-lg border border-line bg-surface px-3 text-sm">
              <option value="">{t("companySchedule.allStatuses")}</option>
              {statuses
                .filter((s) => s.blocksSchedule)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
            </select>
          </label>
          <button type="submit" className={buttonClasses("secondary", "md", "self-end")}>
            {t("companySchedule.apply")}
          </button>
        </form>
      </Card>

      {data.technicians.length === 0 ? (
        <EmptyState title={t("companySchedule.noTechnicians")} />
      ) : view === "day" ? (
        <DayView data={data} t={t} statusById={statusById} />
      ) : view === "week" ? (
        <WeekView data={data} t={t} href={href} today={todayKey(tz)} />
      ) : (
        <MonthView data={data} t={t} href={href} today={todayKey(tz)} weekStartsOn={user.settings.weekStartsOn} />
      )}
    </>
  );
}

function hoursLabel(d: ScheduleDay, t: T) {
  if (d.leave) return t("companySchedule.onLeave", { type: t.dyn(`enums.leaveType.${d.leave}`) });
  if (d.hours?.isOff) return t("form.dayOff");
  if (d.closed && !d.hours?.startTime) return t("companySchedule.closed");
  if (d.hours?.startTime && d.hours.endTime) return `${d.hours.startTime}–${d.hours.endTime}`;
  return t("companySchedule.noSetHours");
}

const isOff = (d: ScheduleDay) => !!d.leave || d.hours?.isOff === true || (d.closed && !d.hours?.startTime);

function hoursText(minutes: number, t: T) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? t("companySchedule.hoursMinutes", { h, m }) : t("companySchedule.hoursOnly", { h });
}

function Workload({ d, t }: { d: ScheduleDay; t: T }) {
  if (isOff(d)) return null;
  const pct = d.capacityMinutes > 0 ? Math.min(100, Math.round((d.bookedMinutes / d.capacityMinutes) * 100)) : 0;
  return (
    <div className="mt-2">
      <div className="flex justify-between text-xs text-fg-muted">
        <span>{t("companySchedule.booked", { booked: hoursText(d.bookedMinutes, t), capacity: hoursText(d.capacityMinutes, t) })}</span>
        <span dir="ltr">{pct}%</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-muted" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={t("companySchedule.workload")}>
        <div className={cn("h-full rounded-full", pct >= 100 ? "bg-danger" : pct >= 75 ? "bg-warning" : "bg-success")} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function JobLine({ job, t, status }: { job: ScheduleJob; t: T; status?: StatusDTO }) {
  const type = job.visitType ? t.dyn(`enums.visitType.${job.visitType}`) : t("companySchedule.visit");
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-line px-3 py-2 text-sm" data-job={job.visible ? job.code : "hidden"}>
      <bdi className="font-medium tabular-nums">{job.time}</bdi>
      <span className="text-fg-muted">{type}</span>
      {status && <StatusBadge name={status.label} color={status.color} />}
      {job.visible ? (
        <Link href={`/appointments/${job.id}`} className="min-w-0 truncate text-brand-text hover:underline">
          <bdi>{job.code}</bdi>
          {job.customerName ? ` · ${job.customerName}` : ""}
          {job.area ? ` · ${job.area}` : ""}
        </Link>
      ) : (
        <span className="inline-flex items-center gap-1 text-xs text-fg-subtle">
          <EyeOff className="h-3.5 w-3.5" /> {t("companySchedule.detailsHidden")}
        </span>
      )}
    </li>
  );
}

function DayView({ data, t, statusById }: { data: CompanySchedule; t: T; statusById: Map<string, StatusDTO> }) {
  const key = data.days[0]!;
  const a = data.availability[key]!;
  return (
    <>
      <dl className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label={t("companySchedule.availability")}>
        {(["free", "partial", "full", "off"] as const).map((k) => (
          <div key={k} className="rounded-lg border border-line bg-surface p-3">
            <dt className="text-xs text-fg-muted">{t(`companySchedule.avail.${k}`)}</dt>
            <dd className="text-xl font-semibold tabular-nums" data-avail={k}>
              {a[k]}
            </dd>
          </div>
        ))}
      </dl>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {data.technicians.map((tech) => {
          const d = tech.days[key]!;
          return (
            <Card key={tech.id} className="p-4" data-technician={tech.name}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-semibold text-fg">{tech.name}</h3>
                <Badge className={cn(isOff(d) && "bg-warning-soft text-warning")}>{hoursLabel(d, t)}</Badge>
              </div>
              <Workload d={d} t={t} />
              {d.jobIds.length === 0 ? (
                <p className="mt-3 text-sm text-fg-muted">{isOff(d) ? t("companySchedule.notWorking") : t("companySchedule.free")}</p>
              ) : (
                <ul className="mt-3 space-y-2">
                  {d.jobIds.map((id) => (
                    <JobLine key={id} job={data.jobs[id]!} t={t} status={statusById.get(data.jobs[id]!.statusId)} />
                  ))}
                </ul>
              )}
            </Card>
          );
        })}
      </div>
    </>
  );
}

function WeekView({ data, t, href, today }: { data: CompanySchedule; t: T; href: (p: Partial<Search>) => string; today: string }) {
  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[56rem] border-collapse text-sm">
          <caption className="sr-only">{t("companySchedule.title")}</caption>
          <thead>
            <tr className="border-b border-line bg-surface-muted text-start">
              <th scope="col" className="sticky start-0 z-10 bg-surface-muted px-3 py-2 text-start font-medium">
                {t("companySchedule.technician")}
              </th>
              {data.days.map((day) => {
                const a = data.availability[day]!;
                return (
                  <th key={day} scope="col" className={cn("px-2 py-2 text-start font-medium", day === today && "text-brand-text")}>
                    <Link href={href({ view: "day", date: day })} className="hover:underline">
                      {formatKey(day, { weekday: "short", day: "numeric" }, t.locale)}
                    </Link>
                    <span className="block text-xs font-normal text-fg-muted">{t("companySchedule.freeCount", { free: a.free, total: a.free + a.partial + a.full + a.off })}</span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {data.technicians.map((tech) => (
              <tr key={tech.id} className="border-b border-line align-top last:border-0" data-technician={tech.name}>
                <th scope="row" className="sticky start-0 z-10 bg-surface px-3 py-2 text-start font-medium">
                  {tech.name}
                </th>
                {data.days.map((day) => {
                  const d = tech.days[day]!;
                  return (
                    <td key={day} className={cn("px-2 py-2", isOff(d) && "bg-surface-muted/60")}>
                      <span className="block text-xs text-fg-muted">{hoursLabel(d, t)}</span>
                      <ul className="mt-1 space-y-1">
                        {d.jobIds.map((id) => {
                          const j = data.jobs[id]!;
                          return (
                            <li key={id} className="rounded border border-line px-1.5 py-0.5 text-xs">
                              <bdi className="tabular-nums">{j.time}</bdi>
                              <span className="block truncate text-fg-muted">
                                {j.visible ? (
                                  <Link href={`/appointments/${j.id}`} className="text-brand-text hover:underline">
                                    <bdi>{j.code}</bdi>
                                  </Link>
                                ) : j.visitType ? (
                                  t.dyn(`enums.visitType.${j.visitType}`)
                                ) : (
                                  t("companySchedule.visit")
                                )}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                      {!isOff(d) && d.bookedMinutes > 0 && <span className="mt-1 block text-xs text-fg-subtle">{hoursText(d.bookedMinutes, t)}</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function MonthView({ data, t, href, today, weekStartsOn }: { data: CompanySchedule; t: T; href: (p: Partial<Search>) => string; today: string; weekStartsOn: number }) {
  const first = startOfWeekKey(data.from, weekStartsOn);
  const cells: string[] = [];
  for (let d = first; d <= data.to || cells.length % 7 !== 0; d = addDaysToKey(d, 1)) cells.push(d);
  const weekdays = cells.slice(0, 7);
  const jobsOn = (day: string) => new Set(data.technicians.flatMap((x) => x.days[day]?.jobIds ?? [])).size;
  return (
    <Card className="p-2 sm:p-4">
      <div className="grid grid-cols-7 gap-1 text-center text-xs font-medium text-fg-muted" aria-hidden>
        {weekdays.map((d) => (
          <div key={d} className="truncate py-1">
            {formatKey(d, { weekday: "short" }, t.locale)}
          </div>
        ))}
      </div>
      <ol className="grid grid-cols-7 gap-1">
        {cells.map((day) => {
          const inMonth = day >= data.from && day <= data.to;
          const a = data.availability[day];
          const n = inMonth ? jobsOn(day) : 0;
          return (
            <li key={day} className={cn("min-w-0 rounded-lg border border-line p-1 sm:p-2", !inMonth && "opacity-40", day === today && "border-brand")}>
              {inMonth ? (
                <Link href={href({ view: "day", date: day })} className="block min-w-0" aria-label={`${formatKey(day, { weekday: "long", day: "numeric", month: "long" }, t.locale)}: ${t("companySchedule.jobsCount", { count: n })}`}>
                  <span className="block text-xs font-semibold tabular-nums">{Number(day.slice(8))}</span>
                  <span className="block truncate text-[11px] text-fg-muted sm:text-xs">{t("companySchedule.jobsCount", { count: n })}</span>
                  {a && <span className="hidden truncate text-xs text-success sm:block">{t("companySchedule.freeCount", { free: a.free, total: a.free + a.partial + a.full + a.off })}</span>}
                </Link>
              ) : (
                <span className="block text-xs tabular-nums">{Number(day.slice(8))}</span>
              )}
            </li>
          );
        })}
      </ol>
      <p className="mt-3 text-xs text-fg-muted">{t("companySchedule.monthHint")}</p>
    </Card>
  );
}
