import type { Metadata } from "next";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  CalendarCheck,
  CalendarClock,
  CalendarDays,
  CalendarX,
  CheckCircle2,
  Clock,
  PauseCircle,
  Plus,
} from "lucide-react";
import type { StatusKind } from "@prisma/client";
import { AgendaItem } from "@/components/appointments/agenda-item";
import { AutoRefresh } from "@/components/layout/auto-refresh";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Ltr } from "@/components/ui/ltr";
import { EmptyState, PageHeader } from "@/components/ui/misc";
import { getI18n } from "@/i18n/server";
import type { MessageKey } from "@/i18n/translate";
import { addDaysToKey, addMonthsToKey, startOfMonthKey } from "@/lib/time";
import { requireUser } from "@/server/auth/session";
import { dashboardSummary } from "@/server/services/dashboard";
import { listStatuses } from "@/server/services/statuses";
import { cn } from "@/lib/utils";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getI18n()).t("dash.title") };
}

function greeting(hour: number): MessageKey {
  return hour < 12 ? "dash.goodMorning" : hour < 18 ? "dash.goodAfternoon" : "dash.goodEvening";
}

export default async function DashboardPage() {
  const user = await requireUser();
  const { t, f } = await getI18n();
  const firstName = user.name.split(" ")[0] ?? user.name;
  if (!user.permissions.includes("appointments.view")) {
    return (
      <>
        <PageHeader title={t("dash.welcome", { name: firstName })} />
        <Card>
          <EmptyState title={t("dash.noSections")} description={t("dash.noSectionsText")} />
        </Card>
      </>
    );
  }
  const tz = user.settings.timezone;
  const [summary, statuses] = await Promise.all([dashboardSummary(user), listStatuses()]);
  const idsOf = (kind: StatusKind) => statuses.filter((s) => s.kind === kind).map((s) => s.id).join(",");
  const monthFrom = startOfMonthKey(summary.today);
  const monthTo = addDaysToKey(addMonthsToKey(monthFrom, 1), -1);
  const tech = user.role === "TECHNICIAN";
  const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone: tz }).format(new Date()));

  const cards = [
    { label: t("dash.today"), value: summary.counts.today, icon: CalendarDays, href: `/appointments?from=${summary.today}&to=${summary.today}&sort=startsAt&dir=asc`, hint: t("dash.todayHint") },
    { label: t("dash.upcoming"), value: summary.counts.upcoming, icon: CalendarClock, href: `/appointments?from=${summary.today}&sort=startsAt&dir=asc`, hint: t("dash.upcomingHint") },
    { label: t("dash.scheduled"), value: summary.counts.scheduled, icon: Clock, href: `/appointments?status=${idsOf("SCHEDULED")}&from=${summary.today}&sort=startsAt&dir=asc`, hint: t("dash.scheduledHint") },
    { label: t("dash.completed"), value: summary.counts.completed, icon: CheckCircle2, href: `/appointments?status=${idsOf("COMPLETED")}&from=${monthFrom}&to=${monthTo}`, hint: t("dash.thisMonth") },
    { label: t("dash.postponed"), value: summary.counts.postponed, icon: PauseCircle, href: `/appointments?status=${idsOf("POSTPONED")}`, hint: t("dash.open") },
    { label: t("dash.cancelled"), value: summary.counts.cancelled, icon: CalendarX, href: `/appointments?status=${idsOf("CANCELLED")}&from=${monthFrom}&to=${monthTo}`, hint: t("dash.thisMonth") },
    { label: t("dash.attention"), value: summary.counts.attention, icon: AlertTriangle, href: "#attention", hint: t("dash.attentionHint"), attention: true },
  ];

  return (
    <>
      <AutoRefresh />
      <PageHeader
        title={t(greeting(hour), { name: firstName })}
        description={`${f.longDate(new Date())}${tech ? ` · ${t("dash.yourInstallations")}` : ""}`}
        actions={
          <>
            <ButtonLink href="/calendar" variant="outline">
              <CalendarCheck className="h-4 w-4" /> {tech ? t("nav.mySchedule") : t("dash.openCalendar")}
            </ButtonLink>
            {user.permissions.includes("appointments.manage") && (
              <ButtonLink href="/appointments/new">
                <Plus className="h-4 w-4" /> {t("nav.newAppointment")}
              </ButtonLink>
            )}
          </>
        }
      />

      <section aria-label={t("dash.summary")} className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-4 xl:grid-cols-7">
        {cards.map(({ label, value, icon: Icon, href, hint, attention }) => (
          <Link
            key={href + label}
            href={href}
            className={cn(
              "group rounded-xl border bg-surface p-4 shadow-card transition-colors hover:border-line-strong",
              attention && value > 0 ? "border-warning/50" : "border-line",
            )}
          >
            <div className="flex items-center justify-between">
              <span className={cn("flex h-8 w-8 items-center justify-center rounded-lg", attention && value > 0 ? "bg-warning-soft text-warning" : "bg-brand-soft text-brand-text")}>
                <Icon className="h-4 w-4" />
              </span>
              <ArrowRight className="h-4 w-4 text-fg-subtle opacity-0 transition-opacity group-hover:opacity-100 rtl:-scale-x-100" aria-hidden />
            </div>
            <p className="mt-3 text-2xl font-semibold tabular-nums text-fg">{f.number(value)}</p>
            <p className="text-sm font-medium text-fg">{label}</p>
            <p className="text-xs text-fg-subtle">{hint}</p>
          </Link>
        ))}
      </section>

      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader
            title={tech ? t("dash.myToday") : t("dash.todaysSchedule")}
            description={t("common.appointmentsCount", { count: summary.todays.length })}
            icon={<CalendarDays className="h-4 w-4" />}
            actions={
              <Link href={`/calendar?view=day&date=${summary.today}`} className="text-sm font-medium text-brand-text hover:underline">
                {t("dash.dayView")}
              </Link>
            }
          />
          <div className="space-y-2 p-4">
            {summary.todays.length === 0 ? (
              <EmptyState title={t("dash.nothingToday")} description={tech ? t("dash.nothingTodayTech") : t("dash.nothingTodayAll")} />
            ) : (
              summary.todays.map((a) => <AgendaItem key={a.id} a={a} />)
            )}
          </div>
        </Card>

        <Card id="attention">
          <CardHeader title={t("dash.attention")} description={t("dash.attentionDesc")} icon={<AlertTriangle className="h-4 w-4" />} />
          {summary.attention.length === 0 ? (
            <EmptyState icon={<CheckCircle2 className="h-6 w-6" />} title={t("dash.allClear")} description={t("dash.allClearText")} />
          ) : (
            <ul className="divide-y divide-line">
              {summary.attention.map((a) => (
                <li key={a.id}>
                  <Link href={`/appointments/${a.id}`} prefetch={false} className="flex items-start gap-3 px-5 py-3 hover:bg-surface-muted">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-fg">
                        {a.customerName}{" "}
                        <span className="font-normal text-fg-subtle">
                          · <Ltr>{a.code}</Ltr>
                        </span>
                      </p>
                      <p className="text-xs text-fg-muted">
                        {t(a.reason)} · {f.dateTime(a.startsAt)}
                      </p>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
