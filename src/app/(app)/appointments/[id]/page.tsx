import Link from "next/link";
import { Boxes, CalendarClock, ClipboardCheck, ExternalLink, History, MapPin, MapPinOff, Navigation, Package, Phone, User } from "lucide-react";
import { AppointmentActions } from "@/components/appointments/appointment-actions";
import { ConfirmationControl } from "@/components/appointments/confirmation-control";
import { OutcomePanel } from "@/components/appointments/outcome-panel";
import { PaymentCard } from "@/components/appointments/payment-card";
import { HistoryList } from "@/components/appointments/history-list";
import { AutoRefresh } from "@/components/layout/auto-refresh";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Ltr } from "@/components/ui/ltr";
import { Alert, Badge, DefinitionList, PageHeader, SalesTag, StatusBadge } from "@/components/ui/misc";
import { getI18n } from "@/i18n/server";
import { colorOrFallback } from "@/lib/colors";
import { todayKey } from "@/lib/time";
import { categoryText } from "@/lib/format";
import { requirePagePermission } from "@/server/auth/session";
import { getAppointment, getAppointmentHistory } from "@/server/services/appointments";
import { listStatuses } from "@/server/services/statuses";
import { heldBy } from "@/server/services/stock";
import { loadOr404 } from "./load";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  void params;
  return { title: (await getI18n()).t("appt.pageTitle") };
}

function telHref(phone: string) {
  return `tel:${phone.replace(/[^\d+]/g, "")}`;
}

export default async function AppointmentPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePagePermission("appointments.view");
  const { id } = await params;
  const tz = user.settings.timezone;
  const { t, f, label, sn } = await getI18n();
  const canHistory = user.permissions.includes("history.view");
  const [a, history, allStatuses, myStock] = await Promise.all([
    loadOr404(() => getAppointment(user, id)),
    canHistory ? loadOr404(() => getAppointmentHistory(user, id)) : Promise.resolve(null),
    user.permissions.includes("appointments.manage") ? listStatuses() : Promise.resolve([]),
    // A technician's own custody, offered as quick picks for the installed serial numbers.
    user.role === "TECHNICIAN" ? heldBy(user.id) : Promise.resolve([]),
  ]);
  const today = todayKey(tz);
  const statuses = a.canManage ? allStatuses : [];
  const loc = a.location;
  const cancelled = a.status.kind === "CANCELLED";
  const salesColor = colorOrFallback(a.createdBy.color);
  const reportable = a.canReport && ["SCHEDULED", "IN_PROGRESS", "COMPLETED", "UNABLE_TO_COMPLETE", "NEEDS_REVISIT"].includes(a.status.kind);

  return (
    <>
      <AutoRefresh />
      <div className="mb-6 h-1.5 rounded-full" style={{ backgroundColor: salesColor }} aria-hidden />
      <PageHeader
        breadcrumb={
          <Link href="/appointments" className="hover:text-fg">
            {t("appt.back")}
          </Link>
        }
        title={
          <span className="flex flex-wrap items-center gap-3">
            {a.customer.name}
            <StatusBadge name={sn(a.status)} color={a.status.color} className="text-sm" />
          </span>
        }
        description={
          <>
            <Ltr>{a.code}</Ltr> · {f.longDate(a.startsAt)} · <Ltr>{f.timeRange(a.startsAt, a.endsAt)}</Ltr>
          </>
        }
        actions={
          a.canManage ? (
            <AppointmentActions id={a.id} version={a.version} statusId={a.status.id} statusKind={a.status.kind} statuses={statuses} />
          ) : (
            <Badge>{t("appt.readOnly")}</Badge>
          )
        }
      />

      {/* Phones: the two things a technician needs on site, right at the top. */}
      {(a.customer.phone || loc?.link) && (
        <div className="mb-6 grid grid-cols-2 gap-2 xl:hidden">
          {a.customer.phone && (
            <a href={telHref(a.customer.phone)} className="flex items-center justify-center gap-2 rounded-xl border border-line bg-surface px-3 py-3 text-sm font-semibold text-fg shadow-card">
              <Phone className="h-4 w-4 text-brand-text" /> {t("appt.callCustomer")}
            </a>
          )}
          {loc?.link && (
            <a
              href={loc.link}
              target="_blank"
              rel="noopener noreferrer"
              className="col-start-2 flex items-center justify-center gap-2 rounded-xl bg-brand-strong px-3 py-3 text-sm font-semibold text-white shadow-card"
            >
              <Navigation className="h-4 w-4" /> {t("appt.openLocation")}
            </a>
          )}
        </div>
      )}

      {cancelled && (
        <Alert tone="warning" className="mb-6" title={t("appt.cancelledTitle")}>
          {t("appt.cancelledText")}
        </Alert>
      )}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-6">
          {/* Location first: it is what technicians need most on site. */}
          <Card>
            <CardHeader title={t("appt.location")} icon={<MapPin className="h-4 w-4" />} />
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
                      <Navigation className="h-5 w-5" /> {t("appt.openLocation")}
                      <ExternalLink className="h-4 w-4 opacity-80" />
                    </a>
                  ) : (
                    <Alert tone="warning" title={t("appt.noLocationTitle")}>
                      {a.canManage ? t("appt.noLocationManage") : t("appt.noLocation")}
                    </Alert>
                  )}
                  <DefinitionList
                    items={[
                      { label: t("appt.fullAddress"), value: loc.streetAddress, full: true },
                      { label: t("appt.area"), value: loc.area },
                      { label: t("appt.building"), value: loc.building },
                      { label: t("appt.apartment"), value: loc.apartment },
                      { label: t("appt.floor"), value: loc.floor },
                      { label: t("appt.access"), value: loc.accessInstructions && <span className="whitespace-pre-line">{loc.accessInstructions}</span>, full: true },
                      ...(loc.latitude != null ? [{ label: t("appt.coordinates"), value: <Ltr>{`${loc.latitude}, ${loc.longitude}`}</Ltr> }] : []),
                    ]}
                  />
                </div>
              ) : (
                <p className="flex items-center gap-2 text-sm text-fg-muted">
                  <MapPinOff className="h-4 w-4" /> {t("appt.noAddressPermission")}
                </p>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title={t("appt.installation")} icon={<Package className="h-4 w-4" />} />
            <CardBody>
              <DefinitionList
                items={[
                  { label: t("appt.visitType"), value: a.visitType ? label("visitType", a.visitType) : null },
                  { label: t("appt.category"), value: categoryText(a, label) },
                  { label: t("appt.brandModel"), value: [a.brand, a.model].filter(Boolean).join(" ") || null },
                  { label: t("appt.siteReadiness"), value: a.siteReadiness ? label("siteReadiness", a.siteReadiness) : null },
                  { label: t("appt.internet"), value: a.internetStatus ? label("internet", a.internetStatus) : null },
                  { label: t("appt.equipmentAt"), value: a.equipmentAt ? label("equipmentAt", a.equipmentAt) : null },
                  { label: t("appt.description"), value: a.description && <span className="whitespace-pre-line">{a.description}</span>, full: true },
                  { label: t("appt.requiredEquipment"), value: a.requiredEquipment && <span className="whitespace-pre-line">{a.requiredEquipment}</span>, full: true },
                  { label: t("appt.additionalNotes"), value: a.additionalNotes && <span className="whitespace-pre-line">{a.additionalNotes}</span>, full: true },
                  ...("internalNotes" in a
                    ? [
                        {
                          label: t("appt.internalNotes"),
                          value: a.internalNotes && <span className="whitespace-pre-line rounded-md bg-warning-soft px-2 py-1">{a.internalNotes}</span>,
                          full: true,
                        },
                      ]
                    : []),
                ]}
              />
            </CardBody>
          </Card>

          {reportable ? (
            <OutcomePanel id={a.id} version={a.version} statusKind={a.status.kind} report={a.visitReport} payment={a.payment} myStock={myStock} />
          ) : (
            a.visitReport && (
              <Card>
                <CardHeader title={t("appt.visitReport")} icon={<ClipboardCheck className="h-4 w-4" />} />
                <CardBody>
                  <p className="whitespace-pre-line text-sm text-fg">{a.visitReport}</p>
                </CardBody>
              </Card>
            )
          )}
          {a.reportedBy && a.reportedAt && (
            <p className="-mt-4 text-xs text-fg-subtle">
              {t("appt.reportBy", { name: a.reportedBy.name })} · {f.dateTime(a.reportedAt)}
            </p>
          )}

          {history && (
            <Card>
              <CardHeader title={t("appt.history")} description={t("appt.historyDesc")} icon={<History className="h-4 w-4" />} />
              <CardBody>
                <HistoryList entries={history} />
              </CardBody>
            </Card>
          )}
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader title={t("appt.customer")} icon={<User className="h-4 w-4" />} />
            <CardBody className="space-y-3">
              <p className="font-medium text-fg">{a.customer.name}</p>
              {a.customer.phone !== undefined ? (
                <div className="space-y-2">
                  <a href={telHref(a.customer.phone)} className="flex items-center gap-2 text-sm font-medium text-brand-text hover:underline">
                    <Phone className="h-4 w-4" /> <Ltr>{a.customer.phone}</Ltr>
                  </a>
                  {a.customer.secondaryPhone && (
                    <a href={telHref(a.customer.secondaryPhone)} className="flex items-center gap-2 text-sm text-fg-muted hover:underline">
                      <Phone className="h-4 w-4" /> <Ltr>{a.customer.secondaryPhone}</Ltr> <span className="text-xs">{t("appt.secondary")}</span>
                    </a>
                  )}
                </div>
              ) : (
                <p className="text-sm text-fg-subtle">{t("appt.contactHidden")}</p>
              )}
              {user.permissions.includes("customers.view") && (
                <Link href={`/customers/${a.customer.id}`} className="inline-block text-sm font-medium text-brand-text hover:underline">
                  {t("appt.customerRecord")}
                </Link>
              )}
            </CardBody>
          </Card>

          {a.payment && <PaymentCard payment={a.payment} />}

          {a.installed.length > 0 && (
            <Card>
              <CardHeader title={t("appt.installedItems")} description={t("appt.installedDesc")} icon={<Boxes className="h-4 w-4" />} />
              <ul className="divide-y divide-line">
                {a.installed.map((i) => (
                  <li key={i.serial} className="px-5 py-3 text-sm">
                    <Ltr className="font-mono font-medium text-fg">{i.serial}</Ltr>
                    <span className="ms-2 text-fg-muted">{i.model}</span>
                    {i.warrantyUntil && (
                      <span className={`block text-xs ${i.warrantyUntil >= today ? "text-success" : "text-fg-subtle"}`}>
                        {t(i.warrantyUntil >= today ? "appt.underWarranty" : "appt.warrantyEnded", { date: f.day(i.warrantyUntil, { day: "numeric", month: "short", year: "numeric" }) })}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card id="schedule">
            <CardHeader title={t("appt.schedule")} icon={<CalendarClock className="h-4 w-4" />} />
            <CardBody>
              <DefinitionList
                className="sm:grid-cols-1"
                items={[
                  { label: t("appt.id"), value: <Ltr className="font-mono">{a.code}</Ltr> },
                  { label: t("appt.date"), value: f.longDate(a.startsAt) },
                  { label: t("appt.time"), value: <Ltr className="tabular-nums">{f.timeRange(a.startsAt, a.endsAt)}</Ltr> },
                  { label: t("appt.duration"), value: f.minutes(a.durationMinutes) },
                  { label: t("appt.status"), value: <StatusBadge name={sn(a.status)} color={a.status.color} /> },
                  {
                    label: t("appt.confirmation"),
                    value: <ConfirmationControl id={a.id} version={a.version} value={a.customerConfirmation} canManage={a.canManage && !cancelled} />,
                  },
                  ...(a.followUpOf
                    ? [{ label: t("appt.followUpOf"), value: <Link href={`/appointments/${a.followUpOf.id}`} className="font-mono text-brand-text hover:underline"><Ltr>{a.followUpOf.code}</Ltr></Link> }]
                    : []),
                  ...(a.followUps.length
                    ? [
                        {
                          label: t("appt.followUps"),
                          value: (
                            <ul className="space-y-1">
                              {a.followUps.map((fu) => (
                                <li key={fu.id} className="flex flex-wrap items-center gap-2">
                                  <Link href={`/appointments/${fu.id}`} className="font-mono text-brand-text hover:underline">
                                    <Ltr>{fu.code}</Ltr>
                                  </Link>
                                  <span className="text-fg-muted">{f.shortDate(fu.startsAt)}</span>
                                  <StatusBadge name={sn(fu.status)} color={fu.status.color} />
                                </li>
                              ))}
                            </ul>
                          ),
                        },
                      ]
                    : []),
                  { label: t("appt.creator"), value: <SalesTag name={a.createdBy.name} color={a.createdBy.color} inactive={!a.createdBy.isActive} /> },
                  {
                    label: t("appt.technicians"),
                    value: a.technicians.length ? (
                      <ul className="space-y-1">
                        {a.technicians.map((tech) => (
                          <li key={tech.id}>
                            {tech.name}
                            {!tech.isActive && <span className="text-xs text-fg-subtle"> {t("common.inactiveParen")}</span>}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <span className="text-warning">{t("list.noTechnician")}</span>
                    ),
                  },
                  { label: t("appt.created"), value: f.dateTime(a.createdAt) },
                  { label: t("appt.lastUpdated"), value: a.updatedBy ? t("appt.updatedBy", { when: f.dateTime(a.updatedAt), name: a.updatedBy.name }) : f.dateTime(a.updatedAt) },
                ]}
              />
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
