import Link from "next/link";
import { ChevronLeft, ChevronRight, MessageCircle, Phone, UserX } from "lucide-react";
import { CopyButton } from "@/components/day-plan/copy-button";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Badge, EmptyState, PageHeader, StatusBadge } from "@/components/ui/misc";
import { addDaysToKey, isValidDateString, todayKey } from "@/lib/time";
import { requirePagePermission } from "@/server/auth/session";
import { dayPlan, type DayPlanVisit } from "@/server/services/day-plan";
import { cn } from "@/lib/utils";
import { getT } from "@/i18n/server";
import type { T } from "@/i18n/translator";
import type { Metadata } from "next";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("nav.dayPlan") };
}

function VisitRow({ v, t }: { v: DayPlanVisit; t: T }) {
  return (
    <li className="space-y-1 px-5 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <bdi className="font-medium tabular-nums text-fg">{v.time}</bdi>
        <Link href={`/appointments/${v.id}`} prefetch={false} className="font-mono text-brand-text hover:underline" dir="ltr">
          {v.code}
        </Link>
        <StatusBadge name={v.status.name} color={v.status.color} />
        <Badge className={cn(!v.confirmed && "border-warning/40 bg-warning-soft text-fg")}>{v.confirmation}</Badge>
      </div>
      <p className="text-fg">
        {v.customerName} <span className="text-fg-muted">· {v.what}</span>
      </p>
      {v.address && <p className="text-fg-muted">{v.address}</p>}
      {v.reminderLink && (
        <a href={v.reminderLink} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-brand-text hover:underline">
          <MessageCircle className="h-3.5 w-3.5" /> {t("dayPlan.remind", { name: v.customerName.split(" ")[0] })}
        </a>
      )}
    </li>
  );
}

export default async function DayPlanPage({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  const [user, t] = await Promise.all([requirePagePermission("appointments.manage"), getT()]);
  const sp = await searchParams;
  const tz = user.settings.timezone;
  const date = sp.date && isValidDateString(sp.date) ? sp.date : addDaysToKey(todayKey(tz), 1);
  const plan = await dayPlan(user, date);

  return (
    <>
      <PageHeader
        title={t("nav.dayPlan")}
        description={t("dayPlan.text")}
        actions={
          <>
            <Link href={`/day-plan?date=${addDaysToKey(date, -1)}`} className={buttonClasses("outline", "sm")} aria-label={t("dayPlan.prevDay")}>
              <ChevronLeft className="h-4 w-4 rtl:rotate-180" />
            </Link>
            <form method="get" className="flex items-center gap-2">
              <input type="date" name="date" defaultValue={date} aria-label={t("calendar.day")} className="h-8 rounded-lg border border-line-strong bg-surface px-2 text-sm text-fg" />
              <button className={buttonClasses("outline", "sm")}>{t("common.show")}</button>
            </form>
            <Link href={`/day-plan?date=${addDaysToKey(date, 1)}`} className={buttonClasses("outline", "sm")} aria-label={t("dayPlan.nextDay")}>
              <ChevronRight className="h-4 w-4 rtl:rotate-180" />
            </Link>
          </>
        }
      />
      <h2 className="mb-4 text-lg font-semibold text-fg">
        {plan.dayLabel} · {t("common.visits", { count: plan.visits })}
      </h2>

      {plan.visits === 0 && (
        <Card>
          <EmptyState title={t("dayPlan.none")} description={t("dayPlan.noneText")} />
        </Card>
      )}

      {plan.unassigned.length > 0 && (
        <Card className="mb-6 border-warning/50">
          <CardHeader title={t("appointments.noTechnician")} description={t("dayPlan.assignFirst")} icon={<UserX className="h-4 w-4" />} />
          <ul className="divide-y divide-line">
            {plan.unassigned.map((v) => (
              <VisitRow key={v.id} v={v} t={t} />
            ))}
          </ul>
        </Card>
      )}

      <div className="grid gap-6 xl:grid-cols-2">
        {plan.technicians.map((tech) => (
          <Card key={tech.id} className="overflow-hidden" data-testid="day-plan-technician">
            <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-4">
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-fg">{tech.name}</p>
                <p className="text-xs text-fg-muted">
                  {t("common.visits", { count: tech.visits.length })}
                  {tech.phone ? (
                    <>
                      {" · "}
                      <a href={`tel:${tech.phone.replace(/[^\d+]/g, "")}`} className="inline-flex items-center gap-1 hover:underline">
                        <Phone className="h-3 w-3" /> <bdi dir="ltr">{tech.phone}</bdi>
                      </a>
                    </>
                  ) : (
                    ` · ${t("dayPlan.noPhone")}`
                  )}
                </p>
              </div>
              <a href={tech.link} target="_blank" rel="noopener noreferrer" className={buttonClasses("primary", "sm")}>
                <MessageCircle className="h-3.5 w-3.5" /> WhatsApp
              </a>
              <CopyButton text={tech.message} />
            </div>
            <ul className="divide-y divide-line">
              {tech.visits.map((v) => (
                <VisitRow key={v.id} v={v} t={t} />
              ))}
            </ul>
            <details className="border-t border-line px-5 py-3">
              <summary className="cursor-pointer text-sm font-medium text-fg-muted">{t("dayPlan.preview")}</summary>
              <pre className="mt-2 whitespace-pre-wrap break-words font-sans text-sm text-fg" dir="auto">
                {tech.message}
              </pre>
            </details>
          </Card>
        ))}
      </div>
    </>
  );
}
