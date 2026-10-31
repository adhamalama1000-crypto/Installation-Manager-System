import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { HeartHandshake, Phone } from "lucide-react";
import { CallForm, GradeForm, RatingForm } from "@/components/after-sales/feedback-forms";
import { Card } from "@/components/ui/card";
import { EmptyState, PageHeader, SalesTag } from "@/components/ui/misc";
import { getT } from "@/i18n/server";
import { shortDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { requireUser } from "@/server/auth/session";
import { afterSalesList, afterSalesLists, type AfterSalesList } from "@/server/services/after-sales";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("nav.afterSales") };
}

export default async function AfterSalesPage({ searchParams }: { searchParams: Promise<{ list?: string }> }) {
  const [user, t] = await Promise.all([requireUser(), getT()]);
  const lists = afterSalesLists(user);
  if (!lists.length) redirect("/access-denied");
  const sp = await searchParams;
  const list: AfterSalesList = lists.includes(sp.list as AfterSalesList) ? (sp.list as AfterSalesList) : lists[0]!;
  const rows = await afterSalesList(user, list);
  const tz = user.settings.timezone;
  return (
    <>
      <PageHeader title={t("afterSales.title")} description={t("afterSales.text")} />
      <nav className="mb-4 flex flex-wrap gap-2" aria-label={t("afterSales.title")}>
        {lists.map((l) => (
          <Link
            key={l}
            href={`/after-sales?list=${l}`}
            aria-current={l === list ? "page" : undefined}
            className={cn(
              "rounded-full border px-3.5 py-1.5 text-sm font-medium",
              l === list ? "border-brand bg-brand-soft text-fg" : "border-line text-fg-muted hover:bg-surface-muted",
            )}
          >
            {t.dyn(`afterSales.lists.${l}`)}
          </Link>
        ))}
      </nav>
      <Card>
        <p className="border-b border-line px-5 py-3 text-sm text-fg-muted">{t.dyn(`afterSales.listText.${list}`)}</p>
        {rows.length === 0 ? (
          <EmptyState title={t("afterSales.empty")} icon={<HeartHandshake className="h-6 w-6" />} />
        ) : (
          <ul className="divide-y divide-line">
            {rows.map((r) => (
              <li key={r.id} className="space-y-2 px-5 py-4">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <Link href={`/appointments/${r.id}`} className="font-medium text-fg hover:underline">
                    {r.customerName}
                  </Link>
                  <bdi className="font-mono text-xs text-fg-subtle">{r.code}</bdi>
                  <span className="text-sm text-fg-muted">{shortDate(r.startsAt, tz, t.locale)}</span>
                  {r.dueMonths && <span className="rounded-full bg-brand-soft px-2 py-0.5 text-xs font-medium text-brand-text">{t("afterSales.due", { months: r.dueMonths })}</span>}
                  <SalesTag name={r.createdBy.name} color={r.createdBy.color} inactive={!r.createdBy.isActive} />
                </div>
                <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-fg-muted">
                  {r.customerPhone && (
                    <a href={`tel:${r.customerPhone.replace(/[^\d+]/g, "")}`} className="inline-flex items-center gap-1 text-brand-text hover:underline">
                      <Phone className="h-4 w-4" /> <bdi dir="ltr">{r.customerPhone}</bdi>
                    </a>
                  )}
                  {r.area && <span>{r.area}</span>}
                  {r.technicians.length > 0 && <span>{r.technicians.map((x) => x.name).join("، ")}</span>}
                </p>
                {r.canAct &&
                  (list === "satisfaction" ? (
                    <RatingForm appointmentId={r.id} rating={null} note={null} />
                  ) : list === "quality" ? (
                    <GradeForm appointmentId={r.id} grade={null} />
                  ) : (
                    <CallForm appointmentId={r.id} months={r.dueMonths ?? 6} />
                  ))}
              </li>
            ))}
          </ul>
        )}
        {rows.length >= 100 && <p className="border-t border-line px-5 py-3 text-xs text-fg-subtle">{t("afterSales.limit", { count: rows.length })}</p>}
      </Card>
    </>
  );
}
