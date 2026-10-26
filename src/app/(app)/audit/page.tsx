import type { Metadata } from "next";
import Link from "next/link";
import { buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Pagination } from "@/components/ui/pagination";
import { Badge, EmptyState, PageHeader } from "@/components/ui/misc";
import { ChangeTable } from "@/components/appointments/history-list";
import { getI18n } from "@/i18n/server";
import { isMessageKey } from "@/i18n/translate";
import { prisma } from "@/server/db";
import { requirePagePermission } from "@/server/auth/session";
import { AUDIT_ENTITY_TYPES, listAuditLog } from "@/server/services/audit-log";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getI18n()).t("audit.title") };
}

type SP = { entityType?: string; actorId?: string; from?: string; to?: string; q?: string; page?: string };

export default async function AuditPage({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await requirePagePermission("audit.view");
  const sp = await searchParams;
  const { t, tm, f } = await getI18n();
  const entityLabel = (type: string) => {
    const key = `audit.entity.${type}`;
    return isMessageKey(key) ? t(key) : type;
  };
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
      <PageHeader title={t("audit.title")} description={t("audit.desc")} />
      <Card className="mb-4 p-4">
        <form method="get" className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <input name="q" defaultValue={sp.q} placeholder={t("audit.search")} aria-label={t("audit.search")} className={`${control} col-span-2 md:col-span-1 xl:col-span-2`} />
          <select name="entityType" defaultValue={sp.entityType ?? ""} aria-label={t("audit.recordType")} className={control}>
            <option value="">{t("audit.allTypes")}</option>
            {AUDIT_ENTITY_TYPES.map((type) => (
              <option key={type} value={type}>
                {entityLabel(type)}
              </option>
            ))}
          </select>
          <select name="actorId" defaultValue={sp.actorId ?? ""} aria-label={t("audit.changedBy")} className={control}>
            <option value="">{t("audit.anyone")}</option>
            {actors.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <input type="date" name="from" defaultValue={sp.from} aria-label={t("audit.fromDate")} className={control} />
          <input type="date" name="to" defaultValue={sp.to} aria-label={t("audit.toDate")} className={control} />
          <div className="col-span-2 flex gap-2 md:col-span-3 xl:col-span-6">
            <button className={buttonClasses("primary")}>{t("common.apply")}</button>
            <Link href="/audit" className={buttonClasses("outline")}>
              {t("common.reset")}
            </Link>
          </div>
        </form>
      </Card>
      <Card className="overflow-hidden">
        {result.items.length === 0 ? (
          <EmptyState title={t("audit.empty")} />
        ) : (
          <>
            <ul className="divide-y divide-line">
              {result.items.map((e) => (
                <li key={e.id} className="px-5 py-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge>{entityLabel(e.entityType)}</Badge>
                    <span dir="ltr" className="font-mono text-[11px] text-fg-subtle">
                      {e.action}
                    </span>
                    <span className="ms-auto text-xs text-fg-subtle">{f.dateTime(e.createdAt)}</span>
                  </div>
                  <p className="mt-1.5 text-sm text-fg">
                    {e.appointmentId ? (
                      <Link href={`/appointments/${e.appointmentId}`} prefetch={false} className="hover:text-brand-text hover:underline">
                        {tm(e.display ?? e.summary)}
                      </Link>
                    ) : (
                      tm(e.display ?? e.summary)
                    )}
                  </p>
                  <p className="text-xs text-fg-muted">{t("audit.by", { name: e.actor?.name ?? t("hist.system") })}</p>
                  {e.changes && e.action !== "APPOINTMENT_CREATED" && (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-xs font-medium text-brand-text">{t("audit.showChanges")}</summary>
                      <ChangeTable changes={e.changes} />
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
