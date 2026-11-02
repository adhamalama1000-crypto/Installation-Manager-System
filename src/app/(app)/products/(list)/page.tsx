import Link from "next/link";
import type { Metadata } from "next";
import { Package, Plus, Settings2 } from "lucide-react";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge, EmptyState, PageHeader } from "@/components/ui/misc";
import { Pagination } from "@/components/ui/pagination";
import { control, nameOf, submitBtn, tableHead, th, thEnd } from "@/components/erp/labels";
import { getT } from "@/i18n/server";
import { money } from "@/lib/constants";
import { formatQuantity } from "@/lib/inventory";
import { hasPermission } from "@/server/access";
import { requirePagePermission } from "@/server/auth/session";
import { catalogOptions, listProducts } from "@/server/services/inventory-catalog";
import { canSeeCosts } from "@/server/services/inventory-common";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("catalog.title") };
}

type SP = { q?: string; categoryId?: string; brandId?: string; active?: string; sort?: string; page?: string };

export default async function ProductsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const [user, t] = await Promise.all([requirePagePermission("products.view"), getT()]);
  const sp = await searchParams;
  const [result, options] = await Promise.all([
    listProducts(user, { q: sp.q, categoryId: sp.categoryId, brandId: sp.brandId, active: sp.active, sort: sp.sort, dir: sp.sort === "created" ? "desc" : "asc", page: Number(sp.page) || 1 }),
    catalogOptions(user),
  ]);
  const manage = hasPermission(user, "products.manage");
  const costs = canSeeCosts(user);
  const L = t.locale;
  const filtered = !!(sp.q || sp.categoryId || sp.brandId || (sp.active && sp.active !== "1"));
  const qs = (page: number) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) if (v && k !== "page") p.set(k, v);
    p.set("page", String(page));
    return `/products?${p}`;
  };
  const tops = options.categories.filter((c) => !c.parentId);
  return (
    <>
      <PageHeader
        title={t("catalog.title")}
        description={t("catalog.text")}
        actions={
          manage && (
            <>
              <ButtonLink href="/products/setup" variant="outline">
                <Settings2 className="h-4 w-4" /> {t("catalog.setup")}
              </ButtonLink>
              <ButtonLink href="/products/new">
                <Plus className="h-4 w-4" /> {t("catalog.newProduct")}
              </ButtonLink>
            </>
          )
        }
      />
      <Card className="mb-4 p-4">
        <form method="get" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_12rem_10rem_9rem_9rem_auto]">
          <input name="q" defaultValue={sp.q} placeholder={t("catalog.search")} aria-label={t("catalog.search")} className={control} />
          <select name="categoryId" defaultValue={sp.categoryId ?? ""} aria-label={t("catalog.products.category")} className={control}>
            <option value="">{t("catalog.allCategories")}</option>
            {tops.map((c) => (
              <optgroup key={c.id} label={nameOf(c, t)}>
                <option value={c.id}>{nameOf(c, t)}</option>
                {options.categories
                  .filter((s) => s.parentId === c.id)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {`${nameOf(c, t)} › ${nameOf(s, t)}`}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
          <select name="brandId" defaultValue={sp.brandId ?? ""} aria-label={t("catalog.products.brand")} className={control}>
            <option value="">{t("catalog.allBrands")}</option>
            {options.brands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
          <select name="active" defaultValue={sp.active ?? "1"} aria-label={t("common.status")} className={control}>
            <option value="1">{t("catalog.activeOnly")}</option>
            <option value="0">{t("catalog.inactiveOnly")}</option>
            <option value="all">{t("catalog.allProducts")}</option>
          </select>
          <select name="sort" defaultValue={sp.sort ?? "name"} aria-label={t("catalog.sort")} className={control}>
            <option value="name">{t("catalog.sortName")}</option>
            <option value="sku">{t("catalog.sortSku")}</option>
            <option value="created">{t("catalog.sortCreated")}</option>
          </select>
          <button type="submit" className={submitBtn}>
            {t("common.search")}
          </button>
        </form>
      </Card>
      <Card className="overflow-hidden">
        {result.rows.length === 0 ? (
          filtered ? (
            <EmptyState title={t("catalog.noMatch")} description={t("catalog.noMatchText")} icon={<Package className="h-6 w-6" />} />
          ) : (
            <EmptyState
              title={t("catalog.none")}
              description={t("catalog.noneText")}
              icon={<Package className="h-6 w-6" />}
              action={manage && <ButtonLink href="/products/new">{t("catalog.newProduct")}</ButtonLink>}
            />
          )
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className={tableHead}>
                <tr>
                  <th className={th}>{t("catalog.products.sku")}</th>
                  <th className={th}>{t("stock.fields.product")}</th>
                  <th className={th}>{t("catalog.products.category")}</th>
                  <th className={th}>{t("catalog.products.brand")}</th>
                  <th className={thEnd}>{t("catalog.onHand")}</th>
                  {costs && <th className={thEnd}>{t("catalog.products.averageCost")}</th>}
                  <th className={thEnd}>{t("catalog.products.sellingPrice")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {result.rows.map((p) => (
                  <tr key={p.id} className="hover:bg-surface-muted/50">
                    <td className="px-4 py-2.5">
                      <Link href={`/products/${p.id}`} className="font-mono font-semibold text-brand-text hover:underline">
                        <bdi>{p.sku}</bdi>
                      </Link>
                    </td>
                    <td className="px-4 py-2.5">
                      <span className="font-medium text-fg">{nameOf(p, t)}</span>
                      <span className="ms-2 inline-flex flex-wrap gap-1 align-middle">
                        {!p.isActive && <Badge>{t("common.inactive")}</Badge>}
                        {p.trackSerials && <Badge>{t("catalog.serialTracked")}</Badge>}
                        {p.low && <Badge className="border-warning/40 bg-warning-soft text-fg">{t("catalog.lowStock")}</Badge>}
                      </span>
                      {p.model && <span className="block text-xs text-fg-subtle">{p.model}</span>}
                    </td>
                    <td className="px-4 py-2.5 text-fg-muted">{p.category ? [p.parentCategory && nameOf(p.parentCategory, t), nameOf(p.category, t)].filter(Boolean).join(" › ") : "—"}</td>
                    <td className="px-4 py-2.5 text-fg-muted">{p.brand?.name ?? "—"}</td>
                    <td className="px-4 py-2.5 text-end tabular-nums">
                      {formatQuantity(p.onHand, L)} <span className="text-xs text-fg-subtle">{p.unit.code}</span>
                    </td>
                    {costs && <td className="px-4 py-2.5 text-end tabular-nums">{money(p.averageCost, L)}</td>}
                    <td className="px-4 py-2.5 text-end tabular-nums">{money(p.sellingPrice, L)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {result.pageCount > 1 && <Pagination page={result.page} pageCount={result.pageCount} total={result.total} hrefFor={qs} />}
      </Card>
    </>
  );
}
