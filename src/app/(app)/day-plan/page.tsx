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

export const metadata = { title: "Day plan" };

function VisitRow({ v }: { v: DayPlanVisit }) {
  return (
    <li className="space-y-1 px-5 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium tabular-nums text-fg">{v.time}</span>
        <Link href={`/appointments/${v.id}`} prefetch={false} className="font-mono text-brand-text hover:underline">
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
          <MessageCircle className="h-3.5 w-3.5" /> Remind {v.customerName.split(" ")[0]} on WhatsApp
        </a>
      )}
    </li>
  );
}

export default async function DayPlanPage({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  const user = await requirePagePermission("appointments.manage");
  const sp = await searchParams;
  const tz = user.settings.timezone;
  const date = sp.date && isValidDateString(sp.date) ? sp.date : addDaysToKey(todayKey(tz), 1);
  const plan = await dayPlan(user, date);

  return (
    <>
      <PageHeader
        title="Day plan"
        description="One WhatsApp message per technician with their visits, ready to send. Nothing is sent automatically."
        actions={
          <>
            <Link href={`/day-plan?date=${addDaysToKey(date, -1)}`} className={buttonClasses("outline", "sm")} aria-label="Previous day">
              <ChevronLeft className="h-4 w-4" />
            </Link>
            <form method="get" className="flex items-center gap-2">
              <input type="date" name="date" defaultValue={date} aria-label="Day" className="h-8 rounded-lg border border-line-strong bg-surface px-2 text-sm text-fg" />
              <button className={buttonClasses("outline", "sm")}>Show</button>
            </form>
            <Link href={`/day-plan?date=${addDaysToKey(date, 1)}`} className={buttonClasses("outline", "sm")} aria-label="Next day">
              <ChevronRight className="h-4 w-4" />
            </Link>
          </>
        }
      />
      <h2 className="mb-4 text-lg font-semibold text-fg">
        {plan.dayLabel} · {plan.visits} visit{plan.visits === 1 ? "" : "s"}
      </h2>

      {plan.visits === 0 && (
        <Card>
          <EmptyState title="No visits on this day." description="Cancelled and postponed visits are not included." />
        </Card>
      )}

      {plan.unassigned.length > 0 && (
        <Card className="mb-6 border-warning/50">
          <CardHeader title="No technician assigned" description="Assign someone before sending the plan." icon={<UserX className="h-4 w-4" />} />
          <ul className="divide-y divide-line">
            {plan.unassigned.map((v) => (
              <VisitRow key={v.id} v={v} />
            ))}
          </ul>
        </Card>
      )}

      <div className="grid gap-6 xl:grid-cols-2">
        {plan.technicians.map((t) => (
          <Card key={t.id} className="overflow-hidden" data-testid="day-plan-technician">
            <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-4">
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-fg">{t.name}</p>
                <p className="text-xs text-fg-muted">
                  {t.visits.length} visit{t.visits.length === 1 ? "" : "s"}
                  {t.phone ? (
                    <>
                      {" · "}
                      <a href={`tel:${t.phone.replace(/[^\d+]/g, "")}`} className="inline-flex items-center gap-1 hover:underline">
                        <Phone className="h-3 w-3" /> {t.phone}
                      </a>
                    </>
                  ) : (
                    " · no phone number saved"
                  )}
                </p>
              </div>
              <a href={t.link} target="_blank" rel="noopener noreferrer" className={buttonClasses("primary", "sm")}>
                <MessageCircle className="h-3.5 w-3.5" /> WhatsApp
              </a>
              <CopyButton text={t.message} />
            </div>
            <ul className="divide-y divide-line">
              {t.visits.map((v) => (
                <VisitRow key={v.id} v={v} />
              ))}
            </ul>
            <details className="border-t border-line px-5 py-3">
              <summary className="cursor-pointer text-sm font-medium text-fg-muted">Message preview</summary>
              <pre className="mt-2 whitespace-pre-wrap break-words font-sans text-sm text-fg">{t.message}</pre>
            </details>
          </Card>
        ))}
      </div>
    </>
  );
}
