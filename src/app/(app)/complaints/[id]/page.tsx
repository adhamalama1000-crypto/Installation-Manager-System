import Link from "next/link";
import { ClipboardList, MessageSquareWarning, Phone } from "lucide-react";
import { ComplaintActions } from "@/components/complaints/complaint-forms";
import { ComplaintBadge } from "@/components/complaints/complaint-badge";
import { AutoRefresh } from "@/components/layout/auto-refresh";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { BackArrow, DefinitionList, PageHeader, StatusBadge } from "@/components/ui/misc";
import { getT } from "@/i18n/server";
import { dateTime, shortDate } from "@/lib/format";
import { formatKey, todayKey } from "@/lib/time";
import { requirePagePermission } from "@/server/auth/session";
import { getComplaint, visitOptions } from "@/server/services/complaints";
import { activeTechnicians } from "@/server/services/users";
import { loadOr404 } from "../../appointments/[id]/load";

export async function generateMetadata() {
  return { title: (await getT())("complaints.title") };
}

export default async function ComplaintPage({ params }: { params: Promise<{ id: string }> }) {
  const [user, t] = await Promise.all([requirePagePermission("complaints.view"), getT()]);
  const { id } = await params;
  const tz = user.settings.timezone;
  const L = t.locale;
  const c = await loadOr404(() => getComplaint(user, id));
  const [technicians, visits] = await Promise.all([c.rights.assign ? activeTechnicians() : Promise.resolve([]), visitOptions(user, c)]);
  const today = todayKey(tz);
  const day = (key: string) => formatKey(key, { day: "numeric", month: "short", year: "numeric" }, L);
  const warranty = !c.warrantyUntil
    ? t("complaints.warrantyNone")
    : c.warrantyUntil >= today
      ? t("complaints.warrantyIn", { date: day(c.warrantyUntil) })
      : t("complaints.warrantyOut", { date: day(c.warrantyUntil) });
  const a = c.appointment;
  return (
    <>
      <AutoRefresh />
      <PageHeader
        breadcrumb={
          <Link href="/complaints" className="hover:text-fg">
            <BackArrow /> {t("nav.complaints")}
          </Link>
        }
        title={
          <span className="flex flex-wrap items-center gap-3">
            <bdi className="font-mono">{c.code}</bdi>
            <ComplaintBadge status={c.status} label={t.dyn(`enums.complaintStatus.${c.status}`)} className="text-sm" />
          </span>
        }
        description={a.customerName}
      />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="space-y-6">
          <Card>
            <CardHeader title={t("complaints.details")} icon={<MessageSquareWarning className="h-4 w-4" />} />
            <CardBody className="space-y-4">
              <div>
                <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-fg-subtle">{t("complaints.description")}</h3>
                <p dir="auto" className="whitespace-pre-line text-sm text-fg">
                  {c.description}
                </p>
              </div>
              {c.resolution && (
                <div>
                  <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-fg-subtle">{t("complaints.resolution")}</h3>
                  <p dir="auto" className="whitespace-pre-line text-sm text-fg">
                    {c.resolution}
                  </p>
                </div>
              )}
              <ul className="space-y-0.5 text-xs text-fg-subtle">
                <li>{t("complaints.openedBy", { name: c.createdBy.name, when: dateTime(c.createdAt, tz, L) })}</li>
                {c.resolvedBy && c.resolvedAt && <li>{t("complaints.resolvedBy", { name: c.resolvedBy.name, when: dateTime(c.resolvedAt, tz, L) })}</li>}
                {c.closedBy && c.closedAt && <li>{t("complaints.closedBy", { name: c.closedBy.name, when: dateTime(c.closedAt, tz, L) })}</li>}
              </ul>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title={t("complaints.visit")} icon={<ClipboardList className="h-4 w-4" />} />
            <CardBody>
              <DefinitionList
                items={[
                  {
                    label: t("complaints.visit"),
                    value: a.canOpen ? (
                      <Link href={`/appointments/${a.id}`} className="font-mono text-brand-text hover:underline" dir="ltr">
                        {a.code}
                      </Link>
                    ) : (
                      <bdi className="font-mono">{a.code}</bdi>
                    ),
                  },
                  { label: t("common.date"), value: shortDate(a.startsAt, tz, L) },
                  { label: t("common.customer"), value: a.customerName },
                  ...(a.customerPhone
                    ? [
                        {
                          label: t("common.phone"),
                          value: (
                            <a href={`tel:${a.customerPhone.replace(/[^\d+]/g, "")}`} className="inline-flex items-center gap-1 text-brand-text hover:underline">
                              <Phone className="h-4 w-4" /> <bdi dir="ltr">{a.customerPhone}</bdi>
                            </a>
                          ),
                        },
                      ]
                    : []),
                  { label: t("location.area"), value: a.area },
                  { label: t("appointment.assignedTechnicians"), value: a.technicians.map((x) => x.name).join("، ") || null },
                  { label: t("complaints.warranty"), value: warranty },
                  {
                    label: t("complaints.maintenanceVisit"),
                    value: c.visit ? (
                      <span className="flex flex-wrap items-center gap-2">
                        {c.visit.canOpen ? (
                          <Link href={`/appointments/${c.visit.id}`} className="font-mono text-brand-text hover:underline" dir="ltr">
                            {c.visit.code}
                          </Link>
                        ) : (
                          <bdi className="font-mono">{c.visit.code}</bdi>
                        )}
                        <span className="text-fg-muted">{shortDate(c.visit.startsAt, tz, L)}</span>
                        <StatusBadge name={c.visit.statusName} color={c.visit.statusColor} />
                      </span>
                    ) : (
                      t("complaints.noVisit")
                    ),
                  },
                  { label: t("complaints.assignedTo"), value: c.assignedTo?.name ?? t("complaints.unassigned") },
                ]}
              />
            </CardBody>
          </Card>
        </div>
        <div className="space-y-6">
          {(c.rights.assign || c.rights.linkVisit || c.rights.resolve || c.rights.close || c.rights.reopen) && (
            <Card>
              <CardHeader title={t("complaints.workflow")} />
              <CardBody>
                <ComplaintActions complaint={c} technicians={technicians.map((x) => ({ id: x.id, name: x.name }))} visits={visits} tz={tz} />
              </CardBody>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
