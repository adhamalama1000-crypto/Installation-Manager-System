import Link from "next/link";
import { notFound } from "next/navigation";
import { ClipboardList, MapPin, Navigation, Phone, Plus } from "lucide-react";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState, PageHeader, SalesTag, StatusBadge } from "@/components/ui/misc";
import { productLine, shortDate, timeRange } from "@/lib/format";
import { requirePagePermission } from "@/server/auth/session";
import { NotFoundError } from "@/server/errors";
import { getCustomer } from "@/server/services/customers";

export const metadata = { title: "Customer" };

export default async function CustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePagePermission("customers.view");
  const { id } = await params;
  const c = await getCustomer(user, id).catch((e) => {
    if (e instanceof NotFoundError) notFound();
    throw e;
  });
  const tz = user.settings.timezone;
  return (
    <>
      <PageHeader
        breadcrumb={<Link href="/customers" className="hover:text-fg">← Customers</Link>}
        title={c.name}
        description={`Customer since ${shortDate(c.createdAt, tz)}`}
        actions={
          user.permissions.includes("appointments.manage") && (
            <ButtonLink href="/appointments/new">
              <Plus className="h-4 w-4" /> New appointment
            </ButtonLink>
          )
        }
      />
      <div className="grid gap-6 xl:grid-cols-[360px_minmax(0,1fr)]">
        <div className="space-y-6">
          {c.phone !== undefined && (
            <Card>
              <CardHeader title="Contact" icon={<Phone className="h-4 w-4" />} />
              <CardBody className="space-y-2 text-sm">
                <a href={`tel:${c.phone.replace(/[^\d+]/g, "")}`} className="block font-medium text-brand-text hover:underline">{c.phone}</a>
                {c.secondaryPhone && <a href={`tel:${c.secondaryPhone.replace(/[^\d+]/g, "")}`} className="block text-fg-muted hover:underline">{c.secondaryPhone} (secondary)</a>}
              </CardBody>
            </Card>
          )}
          {c.locations && (
            <Card>
              <CardHeader title="Installation sites" description={`${c.locations.length} saved`} icon={<MapPin className="h-4 w-4" />} />
              <ul className="divide-y divide-line">
                {c.locations.map((l) => (
                  <li key={l.id} className="space-y-1 px-5 py-4 text-sm">
                    <p className="font-medium text-fg">{[l.building, l.area].filter(Boolean).join(", ") || "Site"}</p>
                    {l.streetAddress && <p className="text-fg-muted">{l.streetAddress}</p>}
                    <p className="text-fg-muted">
                      Apartment {l.apartment ?? "—"} · Floor {l.floor ?? "—"}
                    </p>
                    {l.link ? (
                      <a href={l.link} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 pt-1 font-medium text-brand-text hover:underline">
                        <Navigation className="h-4 w-4" /> Open Location
                      </a>
                    ) : (
                      <p className="pt-1 text-xs text-warning">Location has not been added</p>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
        <Card>
          <CardHeader title="Appointments" description={`${c.appointments.length} total`} icon={<ClipboardList className="h-4 w-4" />} />
          {c.appointments.length === 0 ? (
            <EmptyState title="No appointments you can view" />
          ) : (
            <ul className="divide-y divide-line">
              {c.appointments.map((a) => (
                <li key={a.id}>
                  <Link href={`/appointments/${a.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 hover:bg-surface-muted">
                    <span className="w-28 text-sm font-medium text-brand-text">{a.code}</span>
                    <span className="w-48 text-sm">
                      {shortDate(a.startsAt, tz)} <span className="tabular-nums text-fg-muted">{timeRange(a.startsAt, a.endsAt, tz)}</span>
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm text-fg-muted">{productLine(a)}</span>
                    <SalesTag name={a.createdBy.name} color={a.createdBy.color} className="text-xs" />
                    <StatusBadge name={a.status.name} color={a.status.color} />
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
