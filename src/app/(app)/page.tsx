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
import { EmptyState, PageHeader } from "@/components/ui/misc";
import { addDaysToKey, addMonthsToKey, startOfMonthKey } from "@/lib/time";
import { dateTime, longDate } from "@/lib/format";
import { requireUser } from "@/server/auth/session";
import { dashboardSummary } from "@/server/services/dashboard";
import { listStatuses } from "@/server/services/statuses";
import { cn } from "@/lib/utils";

export const metadata = { title: "Dashboard" };

function greeting(hour: number) {
  return hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}

export default async function DashboardPage() {
  const user = await requireUser();
  if (!user.permissions.includes("appointments.view")) {
    return (
      <>
        <PageHeader title={`Welcome, ${user.name.split(" ")[0]}`} />
        <Card>
          <EmptyState title="No sections enabled yet" description="An administrator has not granted your account access to appointments yet." />
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
    { label: "Today", value: summary.counts.today, icon: CalendarDays, href: `/appointments?from=${summary.today}&to=${summary.today}&sort=startsAt&dir=asc`, hint: "Not cancelled" },
    { label: "Upcoming", value: summary.counts.upcoming, icon: CalendarClock, href: `/appointments?from=${summary.today}&sort=startsAt&dir=asc`, hint: "From now on" },
    { label: "Scheduled", value: summary.counts.scheduled, icon: Clock, href: `/appointments?status=${idsOf("SCHEDULED")}&from=${summary.today}&sort=startsAt&dir=asc`, hint: "Today and later" },
    { label: "Completed", value: summary.counts.completed, icon: CheckCircle2, href: `/appointments?status=${idsOf("COMPLETED")}&from=${monthFrom}&to=${monthTo}`, hint: "This month" },
    { label: "Postponed / rescheduled", value: summary.counts.postponed, icon: PauseCircle, href: `/appointments?status=${idsOf("POSTPONED")}`, hint: "Open" },
    { label: "Cancelled", value: summary.counts.cancelled, icon: CalendarX, href: `/appointments?status=${idsOf("CANCELLED")}&from=${monthFrom}&to=${monthTo}`, hint: "This month" },
    { label: "Needs attention", value: summary.counts.attention, icon: AlertTriangle, href: "#attention", hint: "See list below", attention: true },
  ];

  return (
    <>
      <AutoRefresh />
      <PageHeader
        title={`${greeting(hour)}, ${user.name.split(" ")[0]}`}
        description={`${longDate(new Date(), tz)}${tech ? " · Your assigned installations" : ""}`}
        actions={
          <>
            <ButtonLink href="/calendar" variant="outline">
              <CalendarCheck className="h-4 w-4" /> {tech ? "My schedule" : "Open calendar"}
            </ButtonLink>
            {user.permissions.includes("appointments.manage") && (
              <ButtonLink href="/appointments/new">
                <Plus className="h-4 w-4" /> New appointment
              </ButtonLink>
            )}
          </>
        }
      />

      <section aria-label="Summary" className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-4 xl:grid-cols-7">
        {cards.map(({ label, value, icon: Icon, href, hint, attention }) => (
          <Link
            key={label}
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
              <ArrowRight className="h-4 w-4 text-fg-subtle opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />
            </div>
            <p className="mt-3 text-2xl font-semibold tabular-nums text-fg">{value}</p>
            <p className="text-sm font-medium text-fg">{label}</p>
            <p className="text-xs text-fg-subtle">{hint}</p>
          </Link>
        ))}
      </section>

      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader
            title={tech ? "My appointments today" : "Today's schedule"}
            description={`${summary.todays.length} appointment${summary.todays.length === 1 ? "" : "s"}`}
            icon={<CalendarDays className="h-4 w-4" />}
            actions={
              <Link href={`/calendar?view=day&date=${summary.today}`} className="text-sm font-medium text-brand-text hover:underline">
                Day view
              </Link>
            }
          />
          <div className="space-y-2 p-4">
            {summary.todays.length === 0 ? (
              <EmptyState title="Nothing scheduled today" description={tech ? "You have no installations assigned for today." : "No installations are booked for today."} />
            ) : (
              summary.todays.map((a) => <AgendaItem key={a.id} a={a} tz={tz} />)
            )}
          </div>
        </Card>

        <Card id="attention">
          <CardHeader title="Needs attention" description="Overdue status updates and incomplete bookings" icon={<AlertTriangle className="h-4 w-4" />} />
          {summary.attention.length === 0 ? (
            <EmptyState icon={<CheckCircle2 className="h-6 w-6" />} title="All clear" description="No appointments need attention right now." />
          ) : (
            <ul className="divide-y divide-line">
              {summary.attention.map((a) => (
                <li key={a.id}>
                  <Link href={`/appointments/${a.id}`} className="flex items-start gap-3 px-5 py-3 hover:bg-surface-muted">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-fg">
                        {a.customerName} <span className="font-normal text-fg-subtle">· {a.code}</span>
                      </p>
                      <p className="text-xs text-fg-muted">
                        {a.reason} · {dateTime(a.startsAt, tz)}
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
