import Link from "next/link";
import type { Metadata } from "next";
import { MessageSquareWarning } from "lucide-react";
import { ComplaintBadge } from "@/components/complaints/complaint-badge";
import { AutoRefresh } from "@/components/layout/auto-refresh";
import { Card } from "@/components/ui/card";
import { EmptyState, PageHeader } from "@/components/ui/misc";
import { Pagination } from "@/components/ui/pagination";
import { getT } from "@/i18n/server";
import { dateTime } from "@/lib/format";
import { requirePagePermission } from "@/server/auth/session";
import { listComplaints } from "@/server/services/complaints";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("nav.complaints") };
}

type SP = { status?: string; q?: string; page?: string };
const STATUS_OPTIONS = ["open", "all", "NEW", "ASSIGNED", "RESOLVED", "CLOSED"] as const;

export default async function ComplaintsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const [user, t] = await Promise.all([requirePagePermission("complaints.view"), getT()]);
  const sp = await searchParams;
  const tz = user.settings.timezone;
  const result = await listComplaints(user, { status: sp.status, q: sp.q, page: Number(sp.page) || 1 });
  const tech = user.role === "TECHNICIAN";
  const control = "h-10 w-full rounded-lg border border-line-strong bg-surface px-3 text-sm text-fg";
  const qs = (page: number) => {
    const p = new URLSearchParams();
    if (result.filter !== "open") p.set("status", result.filter);
    if (result.q) p.set("q", result.q);
    p.set("page", String(page));
    return `/complaints?${p}`;
  };
  const label = (s: (typeof STATUS_OPTIONS)[number]) =>
    s === "open" ? t("complaints.filterOpen") : s === "all" ? t("complaints.filterAll") : t.dyn(`enums.complaintStatus.${s}`);
  return (
    <>
      <AutoRefresh />
      <PageHeader title={t("complaints.title")} description={tech ? t("complaints.textTech") : t("complaints.text")} />
      {!tech && (
        <Card className="mb-4 p-4">
          <form method="get" className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_14rem_auto]">
            <input name="q" defaultValue={result.q} placeholder={t("complaints.search")} aria-label={t("complaints.search")} className={control} />
            <select name="status" defaultValue={result.filter} aria-label={t("complaints.filter")} className={control}>
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {label(s)}
                </option>
              ))}
            </select>
            <button type="submit" className="h-10 rounded-lg bg-brand-strong px-4 text-sm font-semibold text-white hover:bg-brand-stronger">
              {t("common.search")}
            </button>
          </form>
        </Card>
      )}
      <Card>
        {result.items.length === 0 ? (
          <EmptyState title={t("complaints.none")} description={t("complaints.noneText")} icon={<MessageSquareWarning className="h-6 w-6" />} />
        ) : (
          <ul className="divide-y divide-line">
            {result.items.map((c) => (
              <li key={c.id}>
                <Link href={`/complaints/${c.id}`} className="block px-5 py-4 hover:bg-surface-muted">
                  <div className="flex flex-wrap items-center gap-2">
                    <bdi className="font-mono text-sm font-semibold text-fg">{c.code}</bdi>
                    <ComplaintBadge status={c.status} label={t.dyn(`enums.complaintStatus.${c.status}`)} />
                    <span className="text-sm text-fg">{c.appointment.customerName}</span>
                    <bdi className="font-mono text-xs text-fg-subtle">{c.appointment.code}</bdi>
                  </div>
                  <p dir="auto" className="mt-1 line-clamp-2 text-start text-sm text-fg-muted">
                    {c.description}
                  </p>
                  <p className="mt-1 text-xs text-fg-subtle">
                    {c.assignedTo ? `${t("complaints.assignedTo")}: ${c.assignedTo.name}` : t("complaints.unassigned")} · {dateTime(c.createdAt, tz, t.locale)}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {result.pageCount > 1 && <Pagination page={result.page} pageCount={result.pageCount} total={result.total} hrefFor={qs} />}
      </Card>
    </>
  );
}
