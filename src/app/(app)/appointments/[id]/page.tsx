import Link from "next/link";
import { Boxes, CalendarClock, ClipboardCheck, ExternalLink, History, MapPin, MapPinOff, MessageSquareWarning, Navigation, Package, Phone, User } from "lucide-react";
import { AppointmentActions } from "@/components/appointments/appointment-actions";
import { ConfirmationControl } from "@/components/appointments/confirmation-control";
import { DeliveryCard } from "@/components/appointments/delivery-card";
import { FeedbackCard } from "@/components/after-sales/feedback-card";
import { ComplaintBadge } from "@/components/complaints/complaint-badge";
import { OpenComplaintButton } from "@/components/complaints/complaint-forms";
import { OutcomePanel } from "@/components/appointments/outcome-panel";
import { PaymentCard } from "@/components/appointments/payment-card";
import { HistoryList } from "@/components/appointments/history-list";
import { AutoRefresh } from "@/components/layout/auto-refresh";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Alert, BackArrow, Badge, DefinitionList, PageHeader, SalesTag, StatusBadge } from "@/components/ui/misc";
import { colorOrFallback } from "@/lib/colors";
import { minutesLabel } from "@/lib/constants";
import { getT } from "@/i18n/server";
import { formatKey, todayKey } from "@/lib/time";
import { categoryText, dateTime, longDate, shortDate, timeRange } from "@/lib/format";
import { requirePagePermission } from "@/server/auth/session";
import { getAppointment, getAppointmentHistory } from "@/server/services/appointments";
import { listAttachments } from "@/server/services/attachments";
import { getFeedback } from "@/server/services/after-sales";
import { canOpenComplaint, complaintsForAppointment } from "@/server/services/complaints";
import { listStatuses } from "@/server/services/statuses";
import { heldBy } from "@/server/services/stock";
import { loadOr404 } from "./load";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  void params;
  return { title: (await getT())("appointment.title") };
}

function telHref(phone: string) {
  return `tel:${phone.replace(/[^\d+]/g, "")}`;
}

export default async function AppointmentPage({ params }: { params: Promise<{ id: string }> }) {
  const [user, t] = await Promise.all([requirePagePermission("appointments.view"), getT()]);
  const { id } = await params;
  const L = t.locale;
  const tz = user.settings.timezone;
  const canHistory = user.permissions.includes("history.view");
  const [a, history, allStatuses, myStock, files, feedback, complaints] = await Promise.all([
    loadOr404(() => getAppointment(user, id)),
    canHistory ? loadOr404(() => getAppointmentHistory(user, id)) : Promise.resolve(null),
    user.permissions.includes("appointments.manage") ? listStatuses(L) : Promise.resolve([]),
    // A technician's own custody, offered as quick picks for the installed serial numbers.
    user.role === "TECHNICIAN" ? heldBy(user.id) : Promise.resolve([]),
    loadOr404(() => listAttachments(user, id)),
    loadOr404(() => getFeedback(user, id)),
    complaintsForAppointment(user, id),
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
            <BackArrow /> {t("nav.appointments")}
          </Link>
        }
        title={
          <span className="flex flex-wrap items-center gap-3">
            {a.customer.name}
            <StatusBadge name={a.status.name} color={a.status.color} className="text-sm" />
          </span>
        }
        description={
          <>
            <bdi>{a.code}</bdi> · {longDate(a.startsAt, tz, L)} · <bdi>{timeRange(a.startsAt, a.endsAt, tz)}</bdi>
          </>
        }
        actions={
          a.canManage ? (
            <AppointmentActions id={a.id} version={a.version} statusId={a.status.id} statusKind={a.status.kind} statuses={statuses} tz={tz} />
          ) : (
            <Badge>{t("appointment.readOnly")}</Badge>
          )
        }
      />

      {/* Phones: the two things a technician needs on site, right at the top. */}
      {(a.customer.phone || loc?.link) && (
        <div className="mb-6 grid grid-cols-2 gap-2 xl:hidden">
          {a.customer.phone && (
            <a href={telHref(a.customer.phone)} className="flex items-center justify-center gap-2 rounded-xl border border-line bg-surface px-3 py-3 text-sm font-semibold text-fg shadow-card">
              <Phone className="h-4 w-4 text-brand-text" /> {t("appointment.callCustomer")}
            </a>
          )}
          {loc?.link && (
            <a
              href={loc.link}
              target="_blank"
              rel="noopener noreferrer"
              className="col-start-2 flex items-center justify-center gap-2 rounded-xl bg-brand-strong px-3 py-3 text-sm font-semibold text-white shadow-card"
            >
              <Navigation className="h-4 w-4" /> {t("appointment.openLocation")}
            </a>
          )}
        </div>
      )}

      {cancelled && (
        <Alert tone="warning" className="mb-6" title={t("appointment.cancelledTitle")}>
          {t("appointment.cancelledText")}
        </Alert>
      )}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-6">
          {/* Location first: it is what technicians need most on site. */}
          <Card>
            <CardHeader title={t("appointment.location")} icon={<MapPin className="h-4 w-4" />} />
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
                      <Navigation className="h-5 w-5" /> {t("appointment.openLocation")}
                      <ExternalLink className="h-4 w-4 opacity-80" />
                    </a>
                  ) : (
                    <Alert tone="warning" title={t("appointment.noLocationTitle")}>
                      {a.canManage ? t("appointment.noLocationManage") : t("appointment.noLocationText")}
                    </Alert>
                  )}
                  <DefinitionList
                    items={[
                      { label: t("location.fullAddress"), value: loc.streetAddress, full: true },
                      { label: t("location.area"), value: loc.area },
                      { label: t("location.building"), value: loc.building },
                      { label: t("location.apartment"), value: loc.apartment },
                      { label: t("location.floor"), value: loc.floor },
                      { label: t("location.access"), value: loc.accessInstructions && <span className="whitespace-pre-line">{loc.accessInstructions}</span>, full: true },
                      ...(loc.latitude != null ? [{ label: t("location.coordinates"), value: <bdi dir="ltr">{`${loc.latitude}, ${loc.longitude}`}</bdi> }] : []),
                    ]}
                  />
                </div>
              ) : (
                <p className="flex items-center gap-2 text-sm text-fg-muted">
                  <MapPinOff className="h-4 w-4" /> {t("appointment.noAddressPermission")}
                </p>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title={t("appointment.installation")} icon={<Package className="h-4 w-4" />} />
            <CardBody>
              <DefinitionList
                items={[
                  { label: t("appointment.visitType"), value: a.visitType ? t.dyn(`enums.visitType.${a.visitType}`) : null },
                  { label: t("appointment.category"), value: categoryText(a, t) },
                  { label: t("appointment.brandModel"), value: [a.brand, a.model].filter(Boolean).join(" ") || null },
                  { label: t("appointment.description"), value: a.description && <span className="whitespace-pre-line">{a.description}</span>, full: true },
                  { label: t("appointment.equipment"), value: a.requiredEquipment && <span className="whitespace-pre-line">{a.requiredEquipment}</span>, full: true },
                  { label: t("appointment.additionalNotes"), value: a.additionalNotes && <span className="whitespace-pre-line">{a.additionalNotes}</span>, full: true },
                  ...("internalNotes" in a
                    ? [
                        {
                          label: t("appointment.internalNotes"),
                          value: a.internalNotes && <span className="whitespace-pre-line rounded-md bg-warning-soft px-2 py-1">{a.internalNotes}</span>,
                          full: true,
                        },
                      ]
                    : []),
                ]}
              />
            </CardBody>
          </Card>

          <DeliveryCard
            id={a.id}
            productCategory={a.productCategory}
            visitType={a.visitType}
            statusKind={a.status.kind}
            canReport={a.canReport}
            enforced={!user.permissions.includes("appointments.manage")}
            rules={{ requireDeliveryProof: user.settings.requireDeliveryProof, serialRequired: user.settings.serialRequired }}
            checklist={a.deliveryChecklist}
            items={files.items}
            rights={files.rights}
            payment={a.payment}
            installedCount={a.installed.length}
            tz={tz}
          />

          {reportable ? (
            <OutcomePanel id={a.id} version={a.version} statusKind={a.status.kind} report={a.visitReport} payment={a.payment} myStock={myStock} />
          ) : (
            a.visitReport && (
              <Card>
                <CardHeader title={t("appointment.visitReport")} icon={<ClipboardCheck className="h-4 w-4" />} />
                <CardBody>
                  <p className="whitespace-pre-line text-sm text-fg">{a.visitReport}</p>
                </CardBody>
              </Card>
            )
          )}
          {a.reportedBy && a.reportedAt && (
            <p className="-mt-4 text-xs text-fg-subtle">
              {t("appointment.reportBy", { name: a.reportedBy.name, when: dateTime(a.reportedAt, tz, L) })}
            </p>
          )}

          <FeedbackCard appointmentId={a.id} feedback={feedback} tz={tz} />

          {(complaints.length > 0 || canOpenComplaint(user, { createdById: a.createdBy.id })) && (
            <Card>
              <CardHeader
                title={t("complaints.onVisit")}
                description={t("complaints.onVisitText")}
                icon={<MessageSquareWarning className="h-4 w-4" />}
                actions={canOpenComplaint(user, { createdById: a.createdBy.id }) ? <OpenComplaintButton appointmentId={a.id} code={a.code} /> : undefined}
              />
              {complaints.length > 0 ? (
                <ul className="divide-y divide-line">
                  {complaints.map((c) => (
                    <li key={c.id}>
                      <Link href={`/complaints/${c.id}`} className="block px-5 py-3 hover:bg-surface-muted">
                        <span className="flex flex-wrap items-center gap-2">
                          <bdi className="font-mono text-sm font-semibold text-fg">{c.code}</bdi>
                          <ComplaintBadge status={c.status} label={t.dyn(`enums.complaintStatus.${c.status}`)} />
                          {c.visit?.id === a.id && <span className="text-xs text-fg-muted">{t("complaints.forVisit", { code: c.appointment.code })}</span>}
                        </span>
                        <span dir="auto" className="mt-0.5 line-clamp-2 block text-start text-sm text-fg-muted">
                          {c.description}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <CardBody>
                  <p className="text-sm text-fg-subtle">{t("complaints.none")}</p>
                </CardBody>
              )}
            </Card>
          )}

          {history && (
            <Card>
              <CardHeader title={t("appointment.history")} description={t("appointment.historyText")} icon={<History className="h-4 w-4" />} />
              <CardBody>
                <HistoryList entries={history} tz={tz} />
              </CardBody>
            </Card>
          )}
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader title={t("common.customer")} icon={<User className="h-4 w-4" />} />
            <CardBody className="space-y-3">
              <p className="font-medium text-fg">{a.customer.name}</p>
              {a.customer.phone !== undefined ? (
                <div className="space-y-2">
                  <a href={telHref(a.customer.phone)} className="flex items-center gap-2 text-sm font-medium text-brand-text hover:underline">
                    <Phone className="h-4 w-4" /> <bdi dir="ltr">{a.customer.phone}</bdi>
                  </a>
                  {a.customer.secondaryPhone && (
                    <a href={telHref(a.customer.secondaryPhone)} className="flex items-center gap-2 text-sm text-fg-muted hover:underline">
                      <Phone className="h-4 w-4" /> <bdi dir="ltr">{a.customer.secondaryPhone}</bdi> <span className="text-xs">({t("appointment.secondary")})</span>
                    </a>
                  )}
                </div>
              ) : (
                <p className="text-sm text-fg-subtle">{t("appointment.contactHidden")}</p>
              )}
              {user.permissions.includes("customers.view") && (
                <Link href={`/customers/${a.customer.id}`} className="inline-block text-sm font-medium text-brand-text hover:underline">
                  {t("appointment.customerRecord")} <span className="rtl:hidden">→</span>
                  <span className="ltr:hidden">←</span>
                </Link>
              )}
            </CardBody>
          </Card>

          {a.payment && <PaymentCard payment={a.payment} tz={tz} />}

          {a.installed.length > 0 && (
            <Card>
              <CardHeader title={t("appointment.installedItems")} description={t("appointment.installedItemsText")} icon={<Boxes className="h-4 w-4" />} />
              <ul className="divide-y divide-line">
                {a.installed.map((i) => (
                  <li key={i.serial} className="px-5 py-3 text-sm">
                    <bdi className="font-mono font-medium text-fg">{i.serial}</bdi>
                    <span className="ms-2 text-fg-muted">{i.model}</span>
                    {i.warrantyUntil && (
                      <span className={`block text-xs ${i.warrantyUntil >= today ? "text-success" : "text-fg-subtle"}`}>
                        {t(i.warrantyUntil >= today ? "appointment.warrantyUntil" : "appointment.warrantyEnded", {
                          date: formatKey(i.warrantyUntil, { day: "numeric", month: "short", year: "numeric" }, L),
                        })}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card id="schedule">
            <CardHeader title={t("appointment.schedule")} icon={<CalendarClock className="h-4 w-4" />} />
            <CardBody>
              <DefinitionList
                className="sm:grid-cols-1"
                items={[
                  { label: t("appointment.id"), value: <bdi className="font-mono">{a.code}</bdi> },
                  { label: t("common.date"), value: longDate(a.startsAt, tz, L) },
                  { label: t("common.time"), value: <bdi className="tabular-nums">{timeRange(a.startsAt, a.endsAt, tz)}</bdi> },
                  { label: t("appointment.duration"), value: minutesLabel(a.durationMinutes, t) },
                  { label: t("common.status"), value: <StatusBadge name={a.status.name} color={a.status.color} /> },
                  {
                    label: t("appointment.confirmation"),
                    value: <ConfirmationControl id={a.id} version={a.version} value={a.customerConfirmation} canManage={a.canManage && !cancelled} />,
                  },
                  ...(a.followUpOf
                    ? [
                        {
                          label: t("appointment.followUpOf"),
                          value: (
                            <Link href={`/appointments/${a.followUpOf.id}`} className="font-mono text-brand-text hover:underline" dir="ltr">
                              {a.followUpOf.code}
                            </Link>
                          ),
                        },
                      ]
                    : []),
                  ...(a.followUps.length
                    ? [
                        {
                          label: t("appointment.followUps"),
                          value: (
                            <ul className="space-y-1">
                              {a.followUps.map((f) => (
                                <li key={f.id} className="flex flex-wrap items-center gap-2">
                                  <Link href={`/appointments/${f.id}`} className="font-mono text-brand-text hover:underline" dir="ltr">
                                    {f.code}
                                  </Link>
                                  <span className="text-fg-muted">{shortDate(f.startsAt, tz, L)}</span>
                                  <StatusBadge name={f.status.name} color={f.status.color} />
                                </li>
                              ))}
                            </ul>
                          ),
                        },
                      ]
                    : []),
                  { label: t("appointment.salesCreator"), value: <SalesTag name={a.createdBy.name} color={a.createdBy.color} inactive={!a.createdBy.isActive} /> },
                  {
                    label: t("appointment.assignedTechnicians"),
                    value: a.technicians.length ? (
                      <ul className="space-y-1">
                        {a.technicians.map((x) => (
                          <li key={x.id}>
                            {x.name}
                            {!x.isActive && <span className="text-xs text-fg-subtle"> {t("common.inactiveParen")}</span>}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <span className="text-warning">{t("appointments.noTechnician")}</span>
                    ),
                  },
                  { label: t("appointment.created"), value: dateTime(a.createdAt, tz, L) },
                  {
                    label: t("appointment.lastUpdated"),
                    value: a.updatedBy ? t("appointment.updatedBy", { when: dateTime(a.updatedAt, tz, L), name: a.updatedBy.name }) : dateTime(a.updatedAt, tz, L),
                  },
                ]}
              />
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
