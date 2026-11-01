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
  HeartHandshake,
  MessageSquareWarning,
  PauseCircle,
  PhoneCall,
  Plus,
  Star,
} from "lucide-react";
import type { StatusKind } from "@prisma/client";
import { AgendaItem } from "@/components/appointments/agenda-item";
import { AutoRefresh } from "@/components/layout/auto-refresh";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState, PageHeader } from "@/components/ui/misc";
import { getT } from "@/i18n/server";
import type { T } from "@/i18n/translator";
import { addDaysToKey, addMonthsToKey, startOfMonthKey } from "@/lib/time";
import { dateTime, longDate } from "@/lib/format";
import { requireUser } from "@/server/auth/session";
import { dashboardSummary } from "@/server/services/dashboard";
import { listStatuses } from "@/server/services/statuses";
import { cn } from "@/lib/utils";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("nav.dashboard") };
}

function greeting(hour: number, t: T) {
  return hour < 12 ? t("dashboard.goodMorning") : hour < 18 ? t("dashboard.goodAfternoon") : t("dashboard.goodEvening");
}

export default async function DashboardPage() {
  const [user, t] = await Promise.all([requireUser(), getT()]);
  const firstName = user.name.split(" ")[0]!;
  if (!user.permissions.includes("appointments.view")) {
    return (
      <>
        <PageHeader title={t("dashboard.welcome", { name: firstName })} />
        <Card>
          <EmptyState title={t("dashboard.noSections")} description={t("dashboard.noSectionsText")} />
        </Card>
      </>
    );
  }
  const tz = user.settings.timezone;
  const [summary, statuses] = await Promise.all([dashboardSummary(user), listStatuses(t.locale)]);
  const idsOf = (kind: StatusKind) => statuses.filter((s) => s.kind === kind).map((s) => s.id).join(",");
  const monthFrom = startOfMonthKey(summary.today);
  const monthTo = addDaysToKey(addMonthsToKey(monthFrom, 1), -1);
  const tech = user.role === "TECHNICIAN";
  const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone: tz }).format(new Date()));

  const cards = [
    { key: "today", label: t("dashboard.cards.today"), value: summary.counts.today, icon: CalendarDays, href: `/appointments?from=${summary.today}&to=${summary.today}&sort=startsAt&dir=asc`, hint: t("dashboard.cards.todayHint") },
    { key: "upcoming", label: t("dashboard.cards.upcoming"), value: summary.counts.upcoming, icon: CalendarClock, href: `/appointments?from=${summary.today}&sort=startsAt&dir=asc`, hint: t("dashboard.cards.upcomingHint") },
    { key: "scheduled", label: t("dashboard.cards.scheduled"), value: summary.counts.scheduled, icon: Clock, href: `/appointments?status=${idsOf("SCHEDULED")}&from=${summary.today}&sort=startsAt&dir=asc`, hint: t("dashboard.cards.scheduledHint") },
    { key: "completed", label: t("dashboard.cards.completed"), value: summary.counts.completed, icon: CheckCircle2, href: `/appointments?status=${idsOf("COMPLETED")}&from=${monthFrom}&to=${monthTo}`, hint: t("dashboard.cards.thisMonth") },
    { key: "postponed", label: t("dashboard.cards.postponed"), value: summary.counts.postponed, icon: PauseCircle, href: `/appointments?status=${idsOf("POSTPONED")}`, hint: t("dashboard.cards.open") },
    { key: "cancelled", label: t("dashboard.cards.cancelled"), value: summary.counts.cancelled, icon: CalendarX, href: `/appointments?status=${idsOf("CANCELLED")}&from=${monthFrom}&to=${monthTo}`, hint: t("dashboard.cards.thisMonth") },
    { key: "attention", label: t("dashboard.cards.attention"), value: summary.counts.attention, icon: AlertTriangle, href: "#attention", hint: t("dashboard.cards.attentionHint"), attention: true },
  ];

  return (
    <>
      <AutoRefresh />
      <PageHeader
        title={t("dashboard.greeting", { greeting: greeting(hour, t), name: firstName })}
        description={`${longDate(new Date(), tz, t.locale)}${tech ? ` · ${t("dashboard.yourInstallations")}` : ""}`}
        actions={
          <>
            <ButtonLink href="/calendar" variant="outline">
              <CalendarCheck className="h-4 w-4" /> {tech ? t("nav.mySchedule") : t("dashboard.openCalendar")}
            </ButtonLink>
            {user.permissions.includes("appointments.manage") && (
              <ButtonLink href="/appointments/new">
                <Plus className="h-4 w-4" /> {t("nav.newAppointment")}
              </ButtonLink>
            )}
          </>
        }
      />

      <section aria-label={t("dashboard.summary")} className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-4 xl:grid-cols-7">
        {cards.map(({ key, label, value, icon: Icon, href, hint, attention }) => (
          <Link
            key={key}
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
              <ArrowRight className="h-4 w-4 text-fg-subtle opacity-0 transition-opacity group-hover:opacity-100 rtl:rotate-180" aria-hidden />
            </div>
            <p className="mt-3 text-2xl font-semibold tabular-nums text-fg">{value}</p>
            <p className="text-sm font-medium text-fg">{label}</p>
            <p className="text-xs text-fg-subtle">{hint}</p>
          </Link>
        ))}
      </section>

      {summary.afterSales && (
        <section aria-label={t("dashboard.afterSales.title")} className="mt-4 grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-4">
          {[
            ...(summary.afterSales.complaints !== null
              ? [{ key: "complaints", label: t("dashboard.afterSales.complaints"), value: summary.afterSales.complaints, icon: MessageSquareWarning, href: "/complaints", hint: t("dashboard.afterSales.title") }]
              : []),
            ...summary.afterSales.lists.map((l) => ({
              key: l,
              label: t.dyn(`dashboard.afterSales.${l}`),
              value: summary.afterSales![l],
              icon: l === "satisfaction" ? HeartHandshake : l === "quality" ? Star : PhoneCall,
              href: `/after-sales?list=${l}`,
              hint: t.dyn(`dashboard.afterSales.${l}Hint`),
            })),
          ].map(({ key, label, value, icon: Icon, href, hint }) => (
            <Link key={key} href={href} className="group rounded-xl border border-line bg-surface p-4 shadow-card transition-colors hover:border-line-strong">
              <div className="flex items-center justify-between">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-soft text-brand-text">
                  <Icon className="h-4 w-4" />
                </span>
                <ArrowRight className="h-4 w-4 text-fg-subtle opacity-0 transition-opacity group-hover:opacity-100 rtl:rotate-180" aria-hidden />
              </div>
              <p className="mt-3 text-2xl font-semibold tabular-nums text-fg">{value}</p>
              <p className="text-sm font-medium text-fg">{label}</p>
              <p className="text-xs text-fg-subtle">{hint}</p>
            </Link>
          ))}
        </section>
      )}

      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader
            title={tech ? t("dashboard.myToday") : t("dashboard.todaysSchedule")}
            description={t("dashboard.appointmentsCount", { count: summary.todays.length })}
            icon={<CalendarDays className="h-4 w-4" />}
            actions={
              <Link href={`/calendar?view=day&date=${summary.today}`} className="text-sm font-medium text-brand-text hover:underline">
                {t("dashboard.dayView")}
              </Link>
            }
          />
          <div className="space-y-2 p-4">
            {summary.todays.length === 0 ? (
              <EmptyState title={t("dashboard.nothingToday")} description={tech ? t("dashboard.nothingTodayTech") : t("dashboard.nothingTodayText")} />
            ) : (
              summary.todays.map((a) => <AgendaItem key={a.id} a={a} tz={tz} />)
            )}
          </div>
        </Card>

        <Card id="attention">
          <CardHeader title={t("dashboard.cards.attention")} description={t("dashboard.attentionText")} icon={<AlertTriangle className="h-4 w-4" />} />
          {summary.attention.length === 0 ? (
            <EmptyState icon={<CheckCircle2 className="h-6 w-6" />} title={t("dashboard.allClear")} description={t("dashboard.allClearText")} />
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
                          · <bdi>{a.code}</bdi>
                        </span>
                      </p>
                      <p className="text-xs text-fg-muted">
                        {t.msg(a.reason)} · {dateTime(a.startsAt, tz, t.locale)}
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
