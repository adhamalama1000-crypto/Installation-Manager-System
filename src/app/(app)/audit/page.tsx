import Link from "next/link";
import { buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Pagination } from "@/components/ui/pagination";
import { Badge, EmptyState, PageHeader } from "@/components/ui/misc";
import { ChangeTable } from "@/components/appointments/history-list";
import { dateTime } from "@/lib/format";
import { prisma } from "@/server/db";
import { requirePagePermission } from "@/server/auth/session";
import { AUDIT_ENTITY_TYPES, AUDIT_MODULES, auditActions, listAuditLog } from "@/server/services/audit-log";
import { CorrectionButton } from "@/components/audit/correction-button";
import { getT } from "@/i18n/server";
import type { Metadata } from "next";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("nav.audit") };
}

type SP = { entityType?: string; entityId?: string; module?: string; action?: string; actorId?: string; from?: string; to?: string; q?: string; page?: string };

export default async function AuditPage({ searchParams }: { searchParams: Promise<SP> }) {
  const [user, t] = await Promise.all([requirePagePermission("audit.view"), getT()]);
  const entity = (type: string) => t.dyn(`enums.auditEntity.${type}`, undefined, type);
  const moduleName = (m: string) => t.dyn(`permRegistry.modules.${m}`, undefined, m);
  const sp = await searchParams;
  const tz = user.settings.timezone;
  const [result, actors, actions] = await Promise.all([
    listAuditLog(user, { ...sp, page: Number(sp.page) || 1 }),
    prisma.user.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    auditActions(user),
  ]);
  const exportQs = new URLSearchParams(Object.entries(sp).filter(([k, v]) => v && k !== "page") as [string, string][]).toString();
  const control = "h-10 w-full rounded-lg border border-line-strong bg-surface px-3 text-sm text-fg";
  const qs = (page: number) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) if (v && k !== "page") p.set(k, v);
    p.set("page", String(page));
    return `/audit?${p}`;
  };
  return (
    <>
      <PageHeader
        title={t("nav.audit")}
        description={t("auditPage.text")}
        actions={
          <a href={`/api/audit/export${exportQs ? `?${exportQs}` : ""}`} className={buttonClasses("outline", "sm")}>
            {t("auditLog.export")}
          </a>
        }
      />
      <Card className="mb-4 p-4">
        <form method="get" className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <input name="q" defaultValue={sp.q} placeholder={t("auditPage.search")} aria-label={t("auditPage.search")} className={`${control} col-span-2 md:col-span-1 xl:col-span-2`} />
          <select name="module" defaultValue={sp.module ?? ""} aria-label={t("auditLog.module")} className={control}>
            <option value="">{t("auditLog.allModules")}</option>
            {AUDIT_MODULES.map((m) => (
              <option key={m} value={m}>
                {moduleName(m)}
              </option>
            ))}
          </select>
          <select name="action" defaultValue={sp.action ?? ""} aria-label={t("auditLog.action")} className={control}>
            <option value="">{t("auditLog.allActions")}</option>
            {actions.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
          <input name="entityId" defaultValue={sp.entityId} placeholder={t("auditLog.entityId")} aria-label={t("auditLog.entityId")} className={control} dir="ltr" />
          <select name="entityType" defaultValue={sp.entityType ?? ""} aria-label={t("auditPage.recordType")} className={control}>
            <option value="">{t("auditPage.allTypes")}</option>
            {AUDIT_ENTITY_TYPES.map((x) => (
              <option key={x} value={x}>
                {entity(x)}
              </option>
            ))}
          </select>
          <select name="actorId" defaultValue={sp.actorId ?? ""} aria-label={t("auditPage.changedBy")} className={control}>
            <option value="">{t("auditPage.anyone")}</option>
            {actors.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
          <input type="date" name="from" defaultValue={sp.from} aria-label={t("auditPage.fromDate")} className={control} />
          <input type="date" name="to" defaultValue={sp.to} aria-label={t("auditPage.toDate")} className={control} />
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
          <EmptyState title={t("auditPage.none")} />
        ) : (
          <>
            <ul className="divide-y divide-line">
              {result.items.map((e) => (
                <li key={e.id} className="px-5 py-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge>{entity(e.entityType)}</Badge>
                    {e.module && <Badge className="border-transparent bg-surface-muted">{moduleName(e.module)}</Badge>}
                    <span className="font-mono text-[11px] text-fg-subtle" dir="ltr">
                      {e.action}
                    </span>
                    <span className="ms-auto text-xs text-fg-subtle">{dateTime(e.createdAt, tz, t.locale)}</span>
                  </div>
                  <p className="mt-1.5 text-sm text-fg">
                    {e.appointmentId ? (
                      <Link href={`/appointments/${e.appointmentId}`} prefetch={false} className="hover:text-brand-text hover:underline">{e.summary}</Link>
                    ) : (
                      e.summary
                    )}
                  </p>
                  <p className="text-xs text-fg-muted">
                    {t("auditPage.by", { name: e.actor?.name ?? t("history.system") })}
                    {e.context?.ip && (
                      <span className="ms-2 font-mono" dir="ltr" title={e.context.userAgent ?? undefined}>
                        {`${e.context.method} ${e.context.path} · ${e.context.ip}`}
                      </span>
                    )}
                  </p>
                  {e.reason && (
                    <p className="mt-1 text-xs text-fg">
                      <span className="font-medium">{t("auditLog.reason")}:</span>{" "}
                      <span dir="auto">{e.reason}</span>
                    </p>
                  )}
                  <div className="mt-1 flex justify-end">
                    <CorrectionButton auditId={e.id} />
                  </div>
                  {e.changes && e.action !== "APPOINTMENT_CREATED" && (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-xs font-medium text-brand-text">{t("auditPage.showChanges")}</summary>
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
