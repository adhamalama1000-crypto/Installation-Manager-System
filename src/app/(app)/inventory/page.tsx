import Link from "next/link";
import { History } from "lucide-react";
import { GoodsInForm, ModelsManager } from "@/components/inventory/inventory-forms";
import { StockTable } from "@/components/inventory/stock-table";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Alert, PageHeader } from "@/components/ui/misc";
import { Pagination } from "@/components/ui/pagination";
import { STOCK_STATUSES } from "@/lib/constants";
import { getT } from "@/i18n/server";
import type { Metadata } from "next";
import { dateTime } from "@/lib/format";
import { formatKey } from "@/lib/time";
import { requirePagePermission } from "@/server/auth/session";
import { NotFoundError } from "@/server/errors";
import { itemHistory, listModels, stockOverview } from "@/server/services/stock";
import { activeTechnicians } from "@/server/services/users";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("nav.inventory") };
}

type SP = { q?: string; status?: string; modelId?: string; holderId?: string; page?: string; serial?: string };

const control = "h-9 rounded-lg border border-line-strong bg-surface px-3 text-sm text-fg";

export default async function InventoryPage({ searchParams }: { searchParams: Promise<SP> }) {
  const [user, t] = await Promise.all([requirePagePermission("stock.view"), getT()]);
  const L = t.locale;
  const statusLabel = (s: string) => t.dyn(`enums.stockStatus.${s}`);
  const sp = await searchParams;
  const tz = user.settings.timezone;
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
        title={overview.own ? t("nav.myStock") : t("nav.inventory")}
        description={overview.own ? t("inventory.ownText") : t("inventory.text")}
      />

      {sp.serial && (
        <Card className="mb-6">
          <CardHeader title={t("inventory.historyOf", { serial: sp.serial.toUpperCase() })} icon={<History className="h-4 w-4" />} />
          {history ? (
            <div className="space-y-3 p-5">
              <p className="text-sm text-fg">
                <span className="font-medium">{history.item.model.name}</span> · {statusLabel(history.item.status)}
                {history.item.holder && ` (${history.item.holder.name})`}
                {history.item.appointment && (
                  <>
                    {" "}
                    {t("inventory.on")}{" "}
                    <Link href={`/appointments/${history.item.appointment.id}`} prefetch={false} className="font-mono text-brand-text hover:underline" dir="ltr">
                      {history.item.appointment.code}
                    </Link>
                  </>
                )}
                {history.item.warrantyUntil && ` · ${t("inventory.warrantyUntil", { date: formatKey(history.item.warrantyUntil, { day: "numeric", month: "short", year: "numeric" }, L) })}`}
              </p>
              <ol className="space-y-2 border-s border-line ps-4 text-sm">
                {history.movements.map((m) => (
                  <li key={m.id}>
                    <span className="font-medium text-fg">
                      {m.fromStatus ? `${statusLabel(m.fromStatus)} ${L === "ar" ? "←" : "→"} ` : ""}
                      {statusLabel(m.toStatus)}
                    </span>
                    {m.holder && <span className="text-fg-muted"> · {m.holder}</span>}
                    {m.appointment && (
                      <>
                        {" · "}
                        <Link href={`/appointments/${m.appointment.id}`} prefetch={false} className="font-mono text-brand-text hover:underline" dir="ltr">
                          {m.appointment.code}
                        </Link>
                      </>
                    )}
                    {m.note && <span className="text-fg-muted"> · {m.note}</span>}
                    <span className="block text-xs text-fg-subtle">
                      {m.actor} · {dateTime(m.createdAt, tz, L)}
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
              {overview.own ? t("inventory.noItemOwn") : t("inventory.noItem")}
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
          <CardHeader title={t("inventory.byModel")} />
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead className="bg-surface-muted/60 text-start text-xs uppercase tracking-wide text-fg-muted">
                <tr>
                  <th className="px-4 py-2 text-start font-medium">{t("csv.model")}</th>
                  {STOCK_STATUSES.map((s) => (
                    <th key={s} className="px-4 py-2 text-end font-medium">
                      {statusLabel(s)}
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
                          <span className="text-fg-subtle">0</span>
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
          <input name="q" defaultValue={sp.q} placeholder={t("inventory.searchPlaceholder")} aria-label={t("inventory.search")} className={`${control} col-span-2 md:col-span-1`} />
          {!overview.own && (
            <select name="status" defaultValue={sp.status ?? ""} aria-label={t("common.status")} className={control}>
              <option value="">{t("inventory.anyStatus")}</option>
              {STOCK_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {statusLabel(s)}
                </option>
              ))}
            </select>
          )}
          <select name="modelId" defaultValue={sp.modelId ?? ""} aria-label={t("csv.model")} className={control}>
            <option value="">{t("inventory.anyModel")}</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          {technicians.length > 0 && (
            <select name="holderId" defaultValue={sp.holderId ?? ""} aria-label={t("common.technician")} className={control}>
              <option value="">{t("inventory.anyTechnician")}</option>
              {technicians.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
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
          technicians={technicians.map((x) => ({ id: x.id, name: x.name }))}
          historyHref={Object.fromEntries(overview.items.map((i) => [i.serial, qs({ serial: i.serial, page: sp.page })]))}
          tz={tz}
        />
        {overview.total > 0 && <Pagination page={overview.page} pageCount={overview.pageCount} total={overview.total} hrefFor={(p) => qs({ page: String(p) })} />}
      </Card>
    </>
  );
}
