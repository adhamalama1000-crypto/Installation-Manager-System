import Link from "next/link";
import type { Metadata } from "next";
import { Truck } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge, EmptyState, PageHeader } from "@/components/ui/misc";
import { Pagination } from "@/components/ui/pagination";
import { NewSupplierButton } from "@/components/erp/supplier-form";
import { control, submitBtn, tableHead, th, thEnd } from "@/components/erp/labels";
import { getT } from "@/i18n/server";
import { formatKey } from "@/lib/time";
import { hasPermission } from "@/server/access";
import { requirePagePermission } from "@/server/auth/session";
import { listSuppliers } from "@/server/services/suppliers";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("suppliers.title") };
}

type SP = { q?: string; active?: string; page?: string };

export default async function SuppliersPage({ searchParams }: { searchParams: Promise<SP> }) {
  const [user, t] = await Promise.all([requirePagePermission("suppliers.view"), getT()]);
  const sp = await searchParams;
  const result = await listSuppliers(user, { q: sp.q, active: sp.active, page: Number(sp.page) || 1 });
  const manage = hasPermission(user, "suppliers.manage");
  const qs = (page: number) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) if (v && k !== "page") p.set(k, v);
    p.set("page", String(page));
    return `/suppliers?${p}`;
  };
  return (
    <>
      <PageHeader title={t("suppliers.title")} description={t("suppliers.text")} actions={manage && <NewSupplierButton />} />
      <Card className="mb-4 p-4">
        <form method="get" className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_12rem_auto]">
          <input name="q" defaultValue={sp.q} placeholder={t("suppliers.search")} aria-label={t("suppliers.search")} className={control} />
          <select name="active" defaultValue={sp.active ?? "1"} aria-label={t("common.status")} className={control}>
            <option value="1">{t("catalog.activeOnly")}</option>
            <option value="0">{t("catalog.inactiveOnly")}</option>
            <option value="all">{t("common.all")}</option>
          </select>
          <button type="submit" className={submitBtn}>
            {t("common.search")}
          </button>
        </form>
      </Card>
      <Card className="overflow-hidden">
        {result.rows.length === 0 ? (
          <EmptyState title={sp.q ? t("suppliers.noMatch") : t("suppliers.none")} icon={<Truck className="h-6 w-6" />} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className={tableHead}>
                <tr>
                  <th className={th}>{t("suppliers.code")}</th>
                  <th className={th}>{t("suppliers.name")}</th>
                  <th className={th}>{t("suppliers.contactPerson")}</th>
                  <th className={th}>{t("suppliers.phone")}</th>
                  <th className={thEnd}>{t("suppliers.documentCount")}</th>
                  <th className={th}>{t("suppliers.lastDocument")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {result.rows.map((s) => (
                  <tr key={s.id} className="hover:bg-surface-muted/50">
                    <td className="px-4 py-2.5">
                      <Link prefetch={false} href={`/suppliers/${s.id}`} className="font-mono font-semibold text-brand-text hover:underline">
                        {s.code}
                      </Link>
                    </td>
                    <td className="px-4 py-2.5">
                      <span className="font-medium" dir="auto">
                        {t.locale === "ar" && s.nameAr ? s.nameAr : s.name}
                      </span>
                      {!s.isActive && <Badge className="ms-2">{t("common.inactive")}</Badge>}
                    </td>
                    <td className="px-4 py-2.5 text-fg-muted" dir="auto">
                      {s.contactPerson ?? "—"}
                    </td>
                    <td className="px-4 py-2.5 text-fg-muted" dir="ltr">
                      {s.phone ?? "—"}
                    </td>
                    <td className="px-4 py-2.5 text-end tabular-nums">{s.documentCount}</td>
                    <td className="px-4 py-2.5 text-fg-muted">{s.lastDocumentDate ? formatKey(s.lastDocumentDate, { day: "numeric", month: "short", year: "numeric" }, t.locale) : "—"}</td>
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
