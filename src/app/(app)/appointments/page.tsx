import type { Metadata } from "next";
import Link from "next/link";
import { ArrowDown, ArrowUp, Download, MapPinOff, Plus } from "lucide-react";
import { AgendaItem } from "@/components/appointments/agenda-item";
import { FiltersBar } from "@/components/appointments/filters-bar";
import { AutoRefresh } from "@/components/layout/auto-refresh";
import { ButtonLink, buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Pagination } from "@/components/ui/pagination";
import { EmptyState, PageHeader, SalesTag, StatusBadge } from "@/components/ui/misc";
import { productLine, shortDate, timeRange } from "@/lib/format";
import { colorOrFallback } from "@/lib/colors";
import { requirePagePermission } from "@/server/auth/session";
import { listAppointments, parseAppointmentFilters } from "@/server/services/appointments";
import { listStatuses } from "@/server/services/statuses";
import { prisma } from "@/server/db";
import { salesPeople } from "@/server/services/users";
import { ValidationError } from "@/server/errors";
import { getT } from "@/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("nav.appointments") };
}

type SP = Record<string, string | string[] | undefined>;

function SortIcon({ active, dir }: { active: boolean; dir: "asc" | "desc" }) {
  if (!active) return null;
  return dir === "asc" ? <ArrowUp className="h-3.5 w-3.5" /> : <ArrowDown className="h-3.5 w-3.5" />;
}

function first(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v;
}

export default async function AppointmentsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const [user, t] = await Promise.all([requirePagePermission("appointments.view"), getT()]);
  const sp = await searchParams;
  const tz = user.settings.timezone;
  let filters;
  try {
    filters = parseAppointmentFilters(sp);
  } catch (e) {
    if (!(e instanceof ValidationError)) throw e;
    filters = parseAppointmentFilters({});
  }
  const tech = user.role === "TECHNICIAN";
  const [result, statuses, sales, technicians] = await Promise.all([
    listAppointments(user, filters),
    listStatuses(t.locale),
    salesPeople({ includeInactive: true }),
    tech ? Promise.resolve([]) : prisma.user.findMany({ where: { role: "TECHNICIAN" }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);

  const values: Record<string, string | undefined> = {};
  for (const k of ["q", "status", "category", "salesId", "technicianId", "area", "from", "to", "sort", "dir"]) values[k] = first(sp[k]);

  const qs = (overrides: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...values, ...overrides })) if (v !== undefined && v !== "") p.set(k, String(v));
    const s = p.toString();
    return s ? `/appointments?${s}` : "/appointments";
  };
  const sortLink = (key: string) => qs({ sort: key, dir: filters.sort === key && filters.dir === "asc" ? "desc" : "asc", page: undefined });
  const exportHref = `/api/appointments/export?${new URLSearchParams(Object.entries(values).filter(([, v]) => v) as [string, string][]).toString()}`;
  const showLocation = user.permissions.includes("location.view");
  const showPhone = user.permissions.includes("customers.contact");
  const th = "px-4 py-3 text-start text-xs font-semibold uppercase tracking-wide text-fg-subtle";

  return (
    <>
      <AutoRefresh />
      <PageHeader
        title={tech ? t("nav.myAppointments") : t("nav.appointments")}
        description={tech ? t("appointments.listTechText") : t("appointments.listText")}
        actions={
          <>
            <a href={exportHref} className={buttonClasses("outline")}>
              <Download className="h-4 w-4" /> {t("common.exportCsv")}
            </a>
            {user.permissions.includes("appointments.manage") && (
              <ButtonLink href="/appointments/new">
                <Plus className="h-4 w-4" /> {t("nav.newAppointment")}
              </ButtonLink>
            )}
          </>
        }
      />
      <Card className="mb-4 p-4">
        <FiltersBar
          action="/appointments"
          values={values}
          statuses={statuses}
          sales={sales}
          technicians={technicians}
          showLocation={showLocation}
          showTechnicianFilter={!tech}
          searchPlaceholder={t(showPhone && showLocation ? "appointments.searchFull" : showPhone ? "appointments.searchPhone" : showLocation ? "appointments.searchLocation" : "appointments.searchBasic")}
        />
      </Card>

      <Card className="overflow-hidden">
        {result.rows.length === 0 ? (
          <EmptyState title={t("appointments.noneFound")} description={t("appointments.noneFoundText")} />
        ) : (
          <>
            {/* Mobile / tablet: cards */}
            <div className="space-y-2 p-3 lg:hidden">
              {result.rows.map((a) => (
                <AgendaItem key={a.id} a={a} tz={tz} showDate={shortDate(a.startsAt, tz, t.locale)} />
              ))}
            </div>
            {/* Desktop: table */}
            <div className="hidden overflow-x-auto lg:block">
              <table className="w-full min-w-[960px] text-sm">
                <thead className="border-b border-line bg-surface-muted/60">
                  <tr>
                    <th className={th}>
                      <Link href={sortLink("number")} className="inline-flex items-center gap-1 hover:text-fg">{t("appointments.col.id")} <SortIcon active={filters.sort === "number"} dir={filters.dir} /></Link>
                    </th>
                    <th className={th}>
                      <Link href={sortLink("startsAt")} className="inline-flex items-center gap-1 hover:text-fg">{t("appointments.col.dateTime")} <SortIcon active={filters.sort === "startsAt"} dir={filters.dir} /></Link>
                    </th>
                    <th className={th}>
                      <Link href={sortLink("customer")} className="inline-flex items-center gap-1 hover:text-fg">{t("common.customer")} <SortIcon active={filters.sort === "customer"} dir={filters.dir} /></Link>
                    </th>
                    {showLocation && <th className={th}>{t("appointments.col.location")}</th>}
                    <th className={th}>{t("appointments.col.installation")}</th>
                    <th className={th}>{t("common.sales")}</th>
                    <th className={th}>{t("common.technicians")}</th>
                    <th className={th}>{t("common.status")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {result.rows.map((a) => (
                    <tr key={a.id} className="group relative hover:bg-surface-muted/60">
                      <td className="whitespace-nowrap px-4 py-3">
                        <Link href={`/appointments/${a.id}`} prefetch={false} className="font-medium text-brand-text after:absolute after:inset-0 hover:underline" dir="ltr">
                          {a.code}
                        </Link>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3">
                        <div className="font-medium text-fg">{shortDate(a.startsAt, tz, t.locale)}</div>
                        <div className="tabular-nums text-fg-muted">{timeRange(a.startsAt, a.endsAt, tz)}</div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-medium text-fg">{a.customerName}</div>
                        {a.customerPhone && (
                          <div className="whitespace-nowrap text-fg-muted" dir="ltr">
                            {a.customerPhone}
                          </div>
                        )}
                      </td>
                      {showLocation && (
                        <td className="px-4 py-3">
                          <div className="text-fg">{a.building ?? "—"}</div>
                          <div className="flex items-center gap-1 text-fg-muted">
                            {a.area ?? ""}
                            {a.hasLocation === false && <MapPinOff className="h-3.5 w-3.5 text-warning" aria-label={t("appointments.noMapLocation")} />}
                          </div>
                        </td>
                      )}
                      <td className="max-w-[220px] px-4 py-3 text-fg-muted">
                        <span className="line-clamp-2">{productLine(a, t)}</span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="flex items-center gap-2">
                          <span className="h-6 w-1.5 rounded-full" style={{ backgroundColor: colorOrFallback(a.createdBy.color) }} aria-hidden />
                          <SalesTag name={a.createdBy.name} color={a.createdBy.color} className="[&>span:first-child]:hidden" />
                        </span>
                      </td>
                      <td className="px-4 py-3 text-fg-muted">{a.technicians.map((x) => x.name).join("، ") || <span className="text-warning">{t("appointments.unassigned")}</span>}</td>
                      <td className="px-4 py-3">
                        <StatusBadge name={a.status.name} color={a.status.color} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={result.page} pageCount={result.pageCount} total={result.total} hrefFor={(p) => qs({ page: p })} />
          </>
        )}
      </Card>
    </>
  );
}
