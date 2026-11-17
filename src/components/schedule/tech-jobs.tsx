import Link from "next/link";
import { ArrowRight, MapPin, Navigation, Phone, User, Users } from "lucide-react";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState, StatusBadge } from "@/components/ui/misc";
import { getT } from "@/i18n/server";
import { productLine, timeRange } from "@/lib/format";
import { colorOrFallback } from "@/lib/colors";
import type { AppointmentDTO } from "@/lib/types";

/**
 * A technician's jobs for today with what they need on site: time, job type and product, the
 * customer with their phone and address (when their permissions allow), map, notes, the Sales
 * employee who booked it and who else is on the team. Everything comes from getAppointment, so
 * the same redaction rules as the visit page apply.
 */
export async function TechJobsCard({ jobs, tz, today, userId }: { jobs: AppointmentDTO[]; tz: string; today: string; userId: string }) {
  const t = await getT();
  return (
    <Card>
      <CardHeader
        title={t("techJobs.title")}
        description={t("dashboard.appointmentsCount", { count: jobs.length })}
        actions={
          <Link href={`/calendar?view=day&date=${today}`} className="text-sm font-medium text-brand-text hover:underline">
            {t("dashboard.dayView")}
          </Link>
        }
      />
      {jobs.length === 0 ? (
        <EmptyState title={t("dashboard.nothingToday")} description={t("dashboard.nothingTodayTech")} />
      ) : (
        <ol className="space-y-3 p-4">
          {jobs.map((a) => {
            const loc = a.location;
            const address = loc ? [loc.streetAddress, loc.building && t("techJobs.building", { v: loc.building }), loc.floor && t("techJobs.floor", { v: loc.floor }), loc.apartment && t("techJobs.apartment", { v: loc.apartment }), loc.area].filter(Boolean).join("، ") : null;
            const notes = [a.description, a.requiredEquipment && `${t("techJobs.equipment")}: ${a.requiredEquipment}`, a.additionalNotes, loc?.accessInstructions && `${t("techJobs.access")}: ${loc.accessInstructions}`].filter(Boolean) as string[];
            const team = a.technicians.filter((x) => x.id !== userId);
            return (
              <li key={a.id} className="rounded-xl border border-line p-4" data-job={a.code}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-base font-semibold tabular-nums">
                    <bdi>{timeRange(a.startsAt, a.endsAt, tz)}</bdi>
                  </span>
                  <span className="text-xs text-fg-subtle" dir="ltr">
                    {a.code}
                  </span>
                  <StatusBadge name={a.status.name} color={a.status.color} />
                </div>
                <p className="mt-1 text-sm font-medium text-fg">{productLine(a, t)}</p>
                <dl className="mt-3 grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
                  <div className="flex items-start gap-2">
                    <User className="mt-0.5 h-4 w-4 shrink-0 text-fg-subtle" aria-hidden />
                    <div className="min-w-0">
                      <dt className="sr-only">{t("techJobs.customer")}</dt>
                      <dd className="font-medium">{a.customer.name}</dd>
                      {a.customer.phone && (
                        <dd>
                          <a href={`tel:${a.customer.phone}`} className="inline-flex items-center gap-1 text-brand-text hover:underline" dir="ltr">
                            <Phone className="h-3.5 w-3.5" /> {a.customer.phone}
                          </a>
                        </dd>
                      )}
                    </div>
                  </div>
                  {address && (
                    <div className="flex items-start gap-2">
                      <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-fg-subtle" aria-hidden />
                      <div className="min-w-0">
                        <dt className="sr-only">{t("techJobs.address")}</dt>
                        <dd dir="auto">{address}</dd>
                        {loc?.link && (
                          <dd>
                            <a href={loc.link} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-brand-text hover:underline">
                              <Navigation className="h-3.5 w-3.5" /> {t("appointment.openLocation")}
                            </a>
                          </dd>
                        )}
                      </div>
                    </div>
                  )}
                  <div className="flex items-start gap-2">
                    <span className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: colorOrFallback(a.createdBy.color) }} aria-hidden />
                    <div>
                      <dt className="text-xs text-fg-muted">{t("techJobs.salesRep")}</dt>
                      <dd>{a.createdBy.name}</dd>
                    </div>
                  </div>
                  {team.length > 0 && (
                    <div className="flex items-start gap-2">
                      <Users className="mt-0.5 h-4 w-4 shrink-0 text-fg-subtle" aria-hidden />
                      <div>
                        <dt className="text-xs text-fg-muted">{t("techJobs.team")}</dt>
                        <dd>{team.map((x) => x.name).join("، ")}</dd>
                      </div>
                    </div>
                  )}
                </dl>
                {notes.length > 0 && (
                  <ul className="mt-3 space-y-1 rounded-lg bg-surface-muted p-3 text-sm" aria-label={t("techJobs.notes")}>
                    {notes.map((n, i) => (
                      <li key={i} dir="auto">
                        {n}
                      </li>
                    ))}
                  </ul>
                )}
                <div className="mt-3 flex justify-end">
                  <Link href={`/appointments/${a.id}`} className="inline-flex items-center gap-1 text-sm font-medium text-brand-text hover:underline">
                    {t("techJobs.open")} <ArrowRight className="h-4 w-4 rtl:rotate-180" />
                  </Link>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}
