"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Ltr } from "@/components/ui/ltr";
import { EmptyState } from "@/components/ui/misc";
import { useI18n } from "@/i18n/client";
import { api, ApiError } from "@/lib/api-client";

type Holding = { technicianId: string; name: string; amount: number; visits: number; oldest: string };
type Entry = { id: string; technicianId: string; amount: number; collectedAt: string; appointmentId: string; code: string; customerName: string };

/** Cash each technician collected and still holds; the accountant confirms the hand-over. */
export function CashHoldings({ holdings, entries, canReceive }: { holdings: Holding[]; entries: Entry[]; canReceive: boolean }) {
  const { t, f } = useI18n();
  const money = f.money;
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  async function receive(h: Holding) {
    const ids = entries.filter((e) => e.technicianId === h.technicianId).map((e) => e.id);
    setBusy(h.technicianId);
    try {
      // The exact entries shown are received, so cash collected after the page loaded stays held.
      const res = await api<{ amount: number; count: number }>("/api/finance/cash/receive", {
        method: "POST",
        body: { technicianId: h.technicianId, ...(ids.length ? { entryIds: ids } : {}) },
      });
      toast.success(t("cash.receivedToast", { amount: money(res.amount), name: h.name }));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : t("act.couldNotSave"));
    } finally {
      setBusy(null);
      router.refresh();
    }
  }

  return (
    <Card className="overflow-hidden">
      <CardHeader title={t("cash.title")} description={t("cash.desc")} icon={<Wallet className="h-4 w-4" />} />
      {holdings.length === 0 ? (
        <EmptyState title={t("cash.none")} />
      ) : (
        <ul className="divide-y divide-line">
          {holdings.map((h) => {
            const own = entries.filter((e) => e.technicianId === h.technicianId);
            return (
              <li key={h.technicianId} className="px-5 py-4" data-testid="cash-holding">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="font-medium text-fg">{h.name}</span>
                  <span className="text-lg font-semibold tabular-nums text-fg">{money(h.amount)}</span>
                  <span className="text-xs text-fg-subtle">
                    {t("common.visitsCount", { count: h.visits })} · {t("cash.since", { date: f.shortDate(h.oldest) })}
                  </span>
                  {canReceive && (
                    <Button size="sm" className="ms-auto" loading={busy === h.technicianId} disabled={busy !== null} onClick={() => receive(h)}>
                      {t("cash.receivedButton", { amount: money(own.length ? own.reduce((s, e) => s + Math.round(e.amount * 100), 0) / 100 : h.amount) })}
                    </Button>
                  )}
                </div>
                <ul className="mt-2 space-y-1 text-sm text-fg-muted">
                  {own.map((e) => (
                    <li key={e.id} className="flex flex-wrap gap-x-2">
                      <Link href={`/appointments/${e.appointmentId}`} prefetch={false} className="font-mono text-brand-text hover:underline">
                        <Ltr>{e.code}</Ltr>
                      </Link>
                      <span>{e.customerName}</span>
                      <span className="tabular-nums">{money(e.amount)}</span>
                      <span className="text-fg-subtle">{f.date(e.collectedAt)}</span>
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
