import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ClipboardList, MapPin, Navigation, Phone, Plus } from "lucide-react";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Ltr } from "@/components/ui/ltr";
import { EmptyState, PageHeader, SalesTag, StatusBadge } from "@/components/ui/misc";
import { getI18n } from "@/i18n/server";
import { productLine } from "@/lib/format";
import { requirePagePermission } from "@/server/auth/session";
import { NotFoundError } from "@/server/errors";
import { getCustomer } from "@/server/services/customers";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getI18n()).t("cust.pageTitle") };
}

export default async function CustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePagePermission("customers.view");
  const { id } = await params;
  const c = await getCustomer(user, id).catch((e) => {
    if (e instanceof NotFoundError) notFound();
    throw e;
  });
  const { t, f, label, sn } = await getI18n();
  return (
    <>
      <PageHeader
        breadcrumb={
          <Link href="/customers" className="hover:text-fg">
            {t("cust.back")}
          </Link>
        }
        title={c.name}
        description={t("cust.since", { date: f.shortDate(c.createdAt) })}
        actions={
          user.permissions.includes("appointments.manage") && (
            <ButtonLink href="/appointments/new">
              <Plus className="h-4 w-4" /> {t("nav.newAppointment")}
            </ButtonLink>
          )
        }
      />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[360px_minmax(0,1fr)]">
        <div className="space-y-6">
          {c.phone !== undefined && (
            <Card>
              <CardHeader title={t("cust.contact")} icon={<Phone className="h-4 w-4" />} />
              <CardBody className="space-y-2 text-sm">
                <a href={`tel:${c.phone.replace(/[^\d+]/g, "")}`} className="block font-medium text-brand-text hover:underline">
                  <Ltr>{c.phone}</Ltr>
                </a>
                {c.secondaryPhone && (
                  <a href={`tel:${c.secondaryPhone.replace(/[^\d+]/g, "")}`} className="block text-fg-muted hover:underline">
                    <Ltr>{c.secondaryPhone}</Ltr> {t("cust.secondary")}
                  </a>
                )}
              </CardBody>
            </Card>
          )}
          {c.locations && (
            <Card>
              <CardHeader title={t("cust.sites")} description={t("cust.sitesSaved", { count: c.locations.length })} icon={<MapPin className="h-4 w-4" />} />
              <ul className="divide-y divide-line">
                {c.locations.map((l) => (
                  <li key={l.id} className="space-y-1 px-5 py-4 text-sm">
                    <p className="font-medium text-fg">{f.join([l.building, l.area]) || t("cust.site")}</p>
                    {l.streetAddress && <p className="text-fg-muted">{l.streetAddress}</p>}
                    <p className="text-fg-muted">{t("cust.aptFloor", { apt: l.apartment ?? "—", floor: l.floor ?? "—" })}</p>
                    {l.link ? (
                      <a href={l.link} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 pt-1 font-medium text-brand-text hover:underline">
                        <Navigation className="h-4 w-4" /> {t("appt.openLocation")}
                      </a>
                    ) : (
                      <p className="pt-1 text-xs text-warning">{t("cust.noLocation")}</p>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
        <Card>
          <CardHeader title={t("cust.appointments")} description={t("cust.appointmentsTotal", { count: c.appointments.length })} icon={<ClipboardList className="h-4 w-4" />} />
          {c.appointments.length === 0 ? (
            <EmptyState title={t("cust.noneVisible")} />
          ) : (
            <ul className="divide-y divide-line">
              {c.appointments.map((a) => (
                <li key={a.id}>
                  <Link href={`/appointments/${a.id}`} prefetch={false} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 hover:bg-surface-muted">
                    <span className="w-28 text-sm font-medium text-brand-text">
                      <Ltr>{a.code}</Ltr>
                    </span>
                    <span className="w-48 text-sm">
                      {f.shortDate(a.startsAt)} <Ltr className="tabular-nums text-fg-muted">{f.timeRange(a.startsAt, a.endsAt)}</Ltr>
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm text-fg-muted">{productLine(a, label)}</span>
                    <SalesTag name={a.createdBy.name} color={a.createdBy.color} className="text-xs" />
                    <StatusBadge name={sn(a.status)} color={a.status.color} />
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
