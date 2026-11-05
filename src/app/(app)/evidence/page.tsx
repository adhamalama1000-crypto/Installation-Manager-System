import Link from "next/link";
import type { Metadata } from "next";
import { ShieldCheck } from "lucide-react";
import { Card } from "@/components/ui/card";
import { EmptyState, PageHeader } from "@/components/ui/misc";
import { tableHead, th } from "@/components/erp/labels";
import { getT } from "@/i18n/server";
import { dateTime, longDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { requirePagePermission } from "@/server/auth/session";
import { reviewQueue } from "@/server/services/evidence";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("evidence.queue.title") };
}

const TABS = ["SUBMITTED", "REJECTED", "APPROVED"] as const;

/** Visits whose work waits for review, was sent back, or was approved (reviewers). */
export default async function EvidenceQueuePage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const [user, t] = await Promise.all([requirePagePermission("evidence.review"), getT()]);
  const sp = await searchParams;
  const status = TABS.find((x) => x === sp.status) ?? "SUBMITTED";
  const rows = await reviewQueue(user, status);
  const tz = user.settings.timezone;
  const L = t.locale;
  return (
    <>
      <PageHeader title={t("evidence.queue.title")} description={t("evidence.queue.text")} />
      <nav className="mb-4 flex flex-wrap gap-2" aria-label={t("evidence.queue.title")}>
        {TABS.map((x) => (
          <Link
            key={x}
            href={`/evidence?status=${x}`}
            prefetch={false}
            aria-current={x === status ? "page" : undefined}
            className={cn(
              "rounded-full border px-3 py-1.5 text-sm font-medium",
              x === status ? "border-brand bg-brand-soft text-fg" : "border-line text-fg-muted hover:bg-surface-muted",
            )}
          >
            {t(`evidence.queue.tabs.${x}`)}
          </Link>
        ))}
      </nav>
      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <EmptyState title={t(`evidence.queue.empty.${status}`)} icon={<ShieldCheck className="h-6 w-6" />} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className={tableHead}>
                <tr>
                  <th className={th}>{t("evidence.queue.visit")}</th>
                  <th className={th}>{t("evidence.queue.customer")}</th>
                  <th className={th}>{t("evidence.queue.date")}</th>
                  <th className={th}>{t("evidence.queue.by")}</th>
                  <th className={th}>{t("evidence.queue.at")}</th>
                  {status !== "SUBMITTED" && <th className={th}>{t("evidence.queue.note")}</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((r) => (
                  <tr key={r.appointmentId} className="hover:bg-surface-muted/50">
                    <td className="px-4 py-2.5">
                      <Link prefetch={false} href={`/appointments/${r.appointmentId}`} className="font-mono font-semibold text-brand-text hover:underline">
                        {r.code}
                      </Link>
                    </td>
                    <td className="px-4 py-2.5" dir="auto">
                      {r.customerName}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-fg-muted">{longDate(r.startsAt, tz, L)}</td>
                    <td className="px-4 py-2.5" dir="auto">
                      {r.by}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-fg-muted">{dateTime(r.at, tz, L)}</td>
                    {status !== "SUBMITTED" && (
                      <td className="max-w-xs truncate px-4 py-2.5 text-fg-muted" dir="auto" title={r.note ?? undefined}>
                        {r.note}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
