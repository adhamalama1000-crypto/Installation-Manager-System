import type { Metadata } from "next";
import Link from "next/link";
import { History } from "lucide-react";
import { GoodsInForm, ModelsManager } from "@/components/inventory/inventory-forms";
import { StockTable } from "@/components/inventory/stock-table";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Ltr } from "@/components/ui/ltr";
import { Alert, PageHeader } from "@/components/ui/misc";
import { Pagination } from "@/components/ui/pagination";
import { getI18n } from "@/i18n/server";
import { STOCK_STATUSES } from "@/lib/constants";
import { requirePagePermission } from "@/server/auth/session";
import { NotFoundError } from "@/server/errors";
import { itemHistory, listModels, stockOverview } from "@/server/services/stock";
import { activeTechnicians } from "@/server/services/users";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getI18n()).t("inv.title") };
}

type SP = { q?: string; status?: string; modelId?: string; holderId?: string; page?: string; serial?: string };

const control = "h-9 rounded-lg border border-line-strong bg-surface px-3 text-sm text-fg";

export default async function InventoryPage({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await requirePagePermission("stock.view");
  const sp = await searchParams;
  const { t, f, label } = await getI18n();
  const manage = user.permissions.includes("stock.manage");
  const [overview, models, technicians, history] = await Promise.all([
    stockOverview(user, { q: sp.q, status: sp.status, modelId: sp.modelId, holderId: sp.holderId, page: Number(sp.page) || 1 }),
    listModels(user),
    manage || user.role === "ACCOUNTANT" ? activeTechnicians() : Promise.resolve([]),
    sp.serial ? itemHistory(user, sp.serial).catch((e) => (e instanceof NotFoundError ? null : Promise.reject(e))) : Promise.resolve(null),
  ]);
  const qs = (patch: Partial<SP>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ q: sp.q, status: sp.status, modelId: sp.modelId, holderId: sp.holderId, ...patch })) if (v) p.set(k, String(v));
    const s = p.toString();
    return `/inventory${s ? `?${s}` : ""}`;
  };

  return (
    <>
      <PageHeader
        title={overview.own ? t("inv.titleOwn") : t("inv.title")}
        description={overview.own ? t("inv.descOwn") : t("inv.desc")}
      />

      {sp.serial && (
        <Card className="mb-6">
          <CardHeader title={t("inv.historyOf", { serial: sp.serial.toUpperCase() })} icon={<History className="h-4 w-4" />} />
          {history ? (
            <div className="space-y-3 p-5">
              <p className="text-sm text-fg">
                <span className="font-medium">{history.item.model.name}</span> · {label("stockStatus", history.item.status)}
                {history.item.holder && ` (${history.item.holder.name})`}
                {history.item.appointment && (
                  <>
                    {" · "}
                    <Link href={`/appointments/${history.item.appointment.id}`} prefetch={false} className="font-mono text-brand-text hover:underline">
                      <Ltr>{history.item.appointment.code}</Ltr>
                    </Link>
                  </>
                )}
                {history.item.warrantyUntil && ` · ${t("inv.warrantyUntil", { date: f.day(history.item.warrantyUntil, { day: "numeric", month: "short", year: "numeric" }) })}`}
              </p>
              <ol className="space-y-2 border-s border-line ps-4 text-sm">
                {history.movements.map((m) => (
                  <li key={m.id}>
                    <span className="font-medium text-fg">
                      {m.fromStatus ? `${label("stockStatus", m.fromStatus)} ${f.locale === "ar" ? "←" : "→"} ` : ""}
                      {label("stockStatus", m.toStatus)}
                    </span>
                    {m.holder && <span className="text-fg-muted"> · {m.holder}</span>}
                    {m.appointment && (
                      <>
                        {" · "}
                        <Link href={`/appointments/${m.appointment.id}`} prefetch={false} className="font-mono text-brand-text hover:underline">
                          <Ltr>{m.appointment.code}</Ltr>
                        </Link>
                      </>
                    )}
                    {m.note && <span className="text-fg-muted"> · {m.note}</span>}
                    <span className="block text-xs text-fg-subtle">
                      {m.actor} · {f.dateTime(m.createdAt)}
                    </span>
                  </li>
                ))}
              </ol>
              <Link href={qs({ serial: undefined })} className={buttonClasses("ghost", "sm")}>
                {t("common.close")}
              </Link>
            </div>
          ) : (
            <Alert tone="warning" className="m-5">
              {overview.own ? t("inv.notFoundOwn") : t("inv.notFound")}
            </Alert>
          )}
        </Card>
      )}

      {manage && (
        <div className="mb-6 grid gap-6 lg:grid-cols-2">
          <GoodsInForm models={models.filter((m) => m.isActive)} />
          <ModelsManager models={models} />
        </div>
      )}

      {!overview.own && overview.summary.length > 0 && (
        <Card className="mb-6 overflow-hidden">
          <CardHeader title={t("inv.byModel")} />
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead className="bg-surface-muted/60 text-xs uppercase tracking-wide text-fg-muted">
                <tr>
                  <th className="px-4 py-2 text-start font-medium">{t("inv.model")}</th>
                  {STOCK_STATUSES.map((s) => (
                    <th key={s} className="px-4 py-2 text-end font-medium">
                      {label("stockStatus", s)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {overview.summary.map((r) => (
                  <tr key={r.modelId}>
                    <td className="px-4 py-2 font-medium text-fg">{r.name}</td>
                    {STOCK_STATUSES.map((s) => (
                      <td key={s} className="px-4 py-2 text-end tabular-nums">
                        {r.counts[s] ? (
                          <Link href={qs({ modelId: r.modelId, status: s, page: undefined })} className="text-brand-text hover:underline">
                            {r.counts[s]}
                          </Link>
                        ) : (
                          <span className="text-fg-subtle">{0}</span>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card className="mb-4 p-4">
        <form method="get" className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <input name="q" defaultValue={sp.q} placeholder={t("inv.searchPlaceholder")} aria-label={t("inv.searchLabel")} className={`${control} col-span-2 md:col-span-1`} />
          {!overview.own && (
            <select name="status" defaultValue={sp.status ?? ""} aria-label={t("inv.status")} className={control}>
              <option value="">{t("inv.anyStatus")}</option>
              {STOCK_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {label("stockStatus", s)}
                </option>
              ))}
            </select>
          )}
          <select name="modelId" defaultValue={sp.modelId ?? ""} aria-label={t("inv.model")} className={control}>
            <option value="">{t("inv.anyModel")}</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          {technicians.length > 0 && (
            <select name="holderId" defaultValue={sp.holderId ?? ""} aria-label={t("inv.technician")} className={control}>
              <option value="">{t("inv.anyTechnician")}</option>
              {technicians.map((tech) => (
                <option key={tech.id} value={tech.id}>
                  {tech.name}
                </option>
              ))}
            </select>
          )}
          <div className="col-span-2 flex gap-2 md:col-span-4">
            <button className={buttonClasses("primary", "sm")}>{t("common.apply")}</button>
            <Link href="/inventory" className={buttonClasses("outline", "sm")}>
              {t("common.reset")}
            </Link>
          </div>
        </form>
      </Card>

      <Card className="overflow-hidden">
        <StockTable
          items={overview.items}
          canManage={overview.canManage}
          technicians={technicians.map((tech) => ({ id: tech.id, name: tech.name }))}
          historyHref={Object.fromEntries(overview.items.map((i) => [i.serial, qs({ serial: i.serial, page: sp.page })]))}
        />
        {overview.total > 0 && <Pagination page={overview.page} pageCount={overview.pageCount} total={overview.total} hrefFor={(p) => qs({ page: String(p) })} />}
      </Card>
    </>
  );
}
