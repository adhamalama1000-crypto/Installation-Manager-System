import Link from "next/link";
import { CalendarClock, ExternalLink, History, MapPin, MapPinOff, Navigation, Package, Phone, User } from "lucide-react";
import { AppointmentActions } from "@/components/appointments/appointment-actions";
import { HistoryList } from "@/components/appointments/history-list";
import { AutoRefresh } from "@/components/layout/auto-refresh";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Alert, Badge, DefinitionList, PageHeader, SalesTag, StatusBadge } from "@/components/ui/misc";
import { colorOrFallback } from "@/lib/colors";
import { minutesLabel } from "@/lib/constants";
import { categoryText, dateTime, longDate, timeRange } from "@/lib/format";
import { requirePagePermission } from "@/server/auth/session";
import { getAppointment, getAppointmentHistory } from "@/server/services/appointments";
import { listStatuses } from "@/server/services/statuses";
import { loadOr404 } from "./load";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  void params;
  return { title: "Appointment" };
}

function telHref(phone: string) {
  return `tel:${phone.replace(/[^\d+]/g, "")}`;
}

export default async function AppointmentPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePagePermission("appointments.view");
  const { id } = await params;
  const a = await loadOr404(() => getAppointment(user, id));
  const tz = user.settings.timezone;
  const canHistory = user.permissions.includes("history.view");
  const [history, statuses] = await Promise.all([
    canHistory ? getAppointmentHistory(user, id) : Promise.resolve(null),
    a.canManage ? listStatuses() : Promise.resolve([]),
  ]);
  const loc = a.location;
  const cancelled = a.status.kind === "CANCELLED";
  const salesColor = colorOrFallback(a.createdBy.color);

  return (
    <>
      <AutoRefresh />
      <div className="mb-6 h-1.5 rounded-full" style={{ backgroundColor: salesColor }} aria-hidden />
      <PageHeader
        breadcrumb={
          <Link href="/appointments" className="hover:text-fg">
            ← Appointments
          </Link>
        }
        title={
          <span className="flex flex-wrap items-center gap-3">
            {a.customer.name}
            <StatusBadge name={a.status.name} color={a.status.color} className="text-sm" />
          </span>
        }
        description={`${a.code} · ${longDate(a.startsAt, tz)} · ${timeRange(a.startsAt, a.endsAt, tz)}`}
        actions={
          a.canManage ? (
            <AppointmentActions id={a.id} version={a.version} statusId={a.status.id} statusKind={a.status.kind} statuses={statuses} tz={tz} />
          ) : (
            <Badge>Read-only</Badge>
          )
        }
      />

      {/* Phones: the two things a technician needs on site, right at the top. */}
      {(a.customer.phone || loc?.link) && (
        <div className="mb-6 grid grid-cols-2 gap-2 xl:hidden">
          {a.customer.phone && (
            <a href={telHref(a.customer.phone)} className="flex items-center justify-center gap-2 rounded-xl border border-line bg-surface px-3 py-3 text-sm font-semibold text-fg shadow-card">
              <Phone className="h-4 w-4 text-brand-text" /> Call customer
            </a>
          )}
          {loc?.link && (
            <a
              href={loc.link}
              target="_blank"
              rel="noopener noreferrer"
              className="col-start-2 flex items-center justify-center gap-2 rounded-xl bg-brand-strong px-3 py-3 text-sm font-semibold text-white shadow-card"
            >
              <Navigation className="h-4 w-4" /> Open Location
            </a>
          )}
        </div>
      )}

      {cancelled && (
        <Alert tone="warning" className="mb-6" title="This appointment is cancelled">
          It no longer blocks the technicians&apos; schedules.
        </Alert>
      )}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-6">
          {/* Location first: it is what technicians need most on site. */}
          <Card>
            <CardHeader title="Location" icon={<MapPin className="h-4 w-4" />} />
            <CardBody>
              {loc ? (
                <div className="space-y-5">
                  {loc.link ? (
                    <a
                      href={loc.link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hidden w-auto items-center gap-2 rounded-xl bg-brand-strong px-5 py-3.5 text-base font-semibold text-white shadow-card hover:bg-brand-stronger xl:inline-flex"
                    >
                      <Navigation className="h-5 w-5" /> Open Location
                      <ExternalLink className="h-4 w-4 opacity-80" />
                    </a>
                  ) : (
                    <Alert tone="warning" title="Location has not been added">
                      No map link or coordinates are saved for this appointment{a.canManage ? " - edit it to add one." : "."}
                    </Alert>
                  )}
                  <DefinitionList
                    items={[
                      { label: "Full address", value: loc.streetAddress, full: true },
                      { label: "Area / neighbourhood", value: loc.area },
                      { label: "Compound / building", value: loc.building },
                      { label: "Apartment / unit", value: loc.apartment },
                      { label: "Floor", value: loc.floor },
                      { label: "Access instructions", value: loc.accessInstructions && <span className="whitespace-pre-line">{loc.accessInstructions}</span>, full: true },
                      ...(loc.latitude != null ? [{ label: "Coordinates", value: `${loc.latitude}, ${loc.longitude}` }] : []),
                    ]}
                  />
                </div>
              ) : (
                <p className="flex items-center gap-2 text-sm text-fg-muted">
                  <MapPinOff className="h-4 w-4" /> You do not have permission to view the installation address.
                </p>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Installation" icon={<Package className="h-4 w-4" />} />
            <CardBody>
              <DefinitionList
                items={[
                  { label: "Category", value: categoryText(a) },
                  { label: "Brand / model", value: [a.brand, a.model].filter(Boolean).join(" ") || null },
                  { label: "Description", value: a.description && <span className="whitespace-pre-line">{a.description}</span>, full: true },
                  { label: "Required equipment", value: a.requiredEquipment && <span className="whitespace-pre-line">{a.requiredEquipment}</span>, full: true },
                  { label: "Additional notes", value: a.additionalNotes && <span className="whitespace-pre-line">{a.additionalNotes}</span>, full: true },
                  ...("internalNotes" in a
                    ? [
                        {
                          label: "Internal notes",
                          value: a.internalNotes && <span className="whitespace-pre-line rounded-md bg-warning-soft px-2 py-1">{a.internalNotes}</span>,
                          full: true,
                        },
                      ]
                    : []),
                ]}
              />
            </CardBody>
          </Card>

          {history && (
            <Card>
              <CardHeader title="History" description="Every change with who made it and when" icon={<History className="h-4 w-4" />} />
              <CardBody>
                <HistoryList entries={history} tz={tz} />
              </CardBody>
            </Card>
          )}
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Customer" icon={<User className="h-4 w-4" />} />
            <CardBody className="space-y-3">
              <p className="font-medium text-fg">{a.customer.name}</p>
              {a.customer.phone !== undefined ? (
                <div className="space-y-2">
                  <a href={telHref(a.customer.phone)} className="flex items-center gap-2 text-sm font-medium text-brand-text hover:underline">
                    <Phone className="h-4 w-4" /> {a.customer.phone}
                  </a>
                  {a.customer.secondaryPhone && (
                    <a href={telHref(a.customer.secondaryPhone)} className="flex items-center gap-2 text-sm text-fg-muted hover:underline">
                      <Phone className="h-4 w-4" /> {a.customer.secondaryPhone} <span className="text-xs">(secondary)</span>
                    </a>
                  )}
                </div>
              ) : (
                <p className="text-sm text-fg-subtle">Contact details hidden.</p>
              )}
              {user.permissions.includes("customers.view") && (
                <Link href={`/customers/${a.customer.id}`} className="inline-block text-sm font-medium text-brand-text hover:underline">
                  Customer record →
                </Link>
              )}
            </CardBody>
          </Card>

          <Card id="schedule">
            <CardHeader title="Schedule" icon={<CalendarClock className="h-4 w-4" />} />
            <CardBody>
              <DefinitionList
                className="sm:grid-cols-1"
                items={[
                  { label: "Appointment ID", value: <span className="font-mono">{a.code}</span> },
                  { label: "Date", value: longDate(a.startsAt, tz) },
                  { label: "Time", value: <span className="tabular-nums">{timeRange(a.startsAt, a.endsAt, tz)}</span> },
                  { label: "Duration", value: minutesLabel(a.durationMinutes) },
                  { label: "Status", value: <StatusBadge name={a.status.name} color={a.status.color} /> },
                  { label: "Original Sales creator", value: <SalesTag name={a.createdBy.name} color={a.createdBy.color} inactive={!a.createdBy.isActive} /> },
                  {
                    label: "Assigned technicians",
                    value: a.technicians.length ? (
                      <ul className="space-y-1">
                        {a.technicians.map((t) => (
                          <li key={t.id}>
                            {t.name}
                            {!t.isActive && <span className="text-xs text-fg-subtle"> (inactive)</span>}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <span className="text-warning">No technician assigned</span>
                    ),
                  },
                  { label: "Created", value: dateTime(a.createdAt, tz) },
                  { label: "Last updated", value: `${dateTime(a.updatedAt, tz)}${a.updatedBy ? ` by ${a.updatedBy.name}` : ""}` },
                ]}
              />
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
