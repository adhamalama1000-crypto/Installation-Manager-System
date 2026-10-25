import Link from "next/link";
import { buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Pagination } from "@/components/ui/pagination";
import { Badge, EmptyState, PageHeader } from "@/components/ui/misc";
import { ChangeTable } from "@/components/appointments/history-list";
import { dateTime } from "@/lib/format";
import { prisma } from "@/server/db";
import { requirePagePermission } from "@/server/auth/session";
import { AUDIT_ENTITY_TYPES, listAuditLog } from "@/server/services/audit-log";

export const metadata = { title: "Audit log" };

const ENTITY_LABELS: Record<string, string> = { APPOINTMENT: "Appointment", USER: "User", STATUS: "Status", SETTINGS: "Settings", CUSTOMER: "Customer" };

type SP = { entityType?: string; actorId?: string; from?: string; to?: string; q?: string; page?: string };

export default async function AuditPage({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await requirePagePermission("audit.view");
  const sp = await searchParams;
  const tz = user.settings.timezone;
  const [result, actors] = await Promise.all([
    listAuditLog(user, { ...sp, page: Number(sp.page) || 1 }),
    prisma.user.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  const control = "h-10 w-full rounded-lg border border-line-strong bg-surface px-3 text-sm text-fg";
  const qs = (page: number) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) if (v && k !== "page") p.set(k, v);
    p.set("page", String(page));
    return `/audit?${p}`;
  };
  return (
    <>
      <PageHeader title="Audit log" description="Append-only record of appointment, user, status and settings changes. Entries cannot be edited or deleted." />
      <Card className="mb-4 p-4">
        <form method="get" className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <input name="q" defaultValue={sp.q} placeholder="Search summary" aria-label="Search summary" className={`${control} col-span-2 md:col-span-1 xl:col-span-2`} />
          <select name="entityType" defaultValue={sp.entityType ?? ""} aria-label="Record type" className={control}>
            <option value="">All record types</option>
            {AUDIT_ENTITY_TYPES.map((t) => (
              <option key={t} value={t}>{ENTITY_LABELS[t]}</option>
            ))}
          </select>
          <select name="actorId" defaultValue={sp.actorId ?? ""} aria-label="Changed by" className={control}>
            <option value="">Anyone</option>
            {actors.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
          <input type="date" name="from" defaultValue={sp.from} aria-label="From date" className={control} />
          <input type="date" name="to" defaultValue={sp.to} aria-label="To date" className={control} />
          <div className="col-span-2 flex gap-2 md:col-span-3 xl:col-span-6">
            <button className={buttonClasses("primary")}>Apply</button>
            <Link href="/audit" className={buttonClasses("outline")}>Reset</Link>
          </div>
        </form>
      </Card>
      <Card className="overflow-hidden">
        {result.items.length === 0 ? (
          <EmptyState title="No entries" />
        ) : (
          <>
            <ul className="divide-y divide-line">
              {result.items.map((e) => (
                <li key={e.id} className="px-5 py-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge>{ENTITY_LABELS[e.entityType] ?? e.entityType}</Badge>
                    <span className="font-mono text-[11px] text-fg-subtle">{e.action}</span>
                    <span className="ml-auto text-xs text-fg-subtle">{dateTime(e.createdAt, tz)}</span>
                  </div>
                  <p className="mt-1.5 text-sm text-fg">
                    {e.appointmentId ? (
                      <Link href={`/appointments/${e.appointmentId}`} prefetch={false} className="hover:text-brand-text hover:underline">{e.summary}</Link>
                    ) : (
                      e.summary
                    )}
                  </p>
                  <p className="text-xs text-fg-muted">by {e.actor?.name ?? "System"}</p>
                  {e.changes && e.action !== "APPOINTMENT_CREATED" && (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-xs font-medium text-brand-text">Show changes</summary>
                      <ChangeTable changes={e.changes} tz={tz} />
                    </details>
                  )}
                </li>
              ))}
            </ul>
            <Pagination page={result.page} pageCount={result.pageCount} total={result.total} hrefFor={qs} />
          </>
        )}
      </Card>
    </>
  );
}
