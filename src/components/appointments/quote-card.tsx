"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ExternalLink, FileText, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { useT } from "@/i18n/client";
import { api, ApiError } from "@/lib/api-client";
import type { QuoteDTO } from "@/lib/types";

/** The quotation read from the company website: items, and prices for readers who see money. */
export function QuoteCard({ appointmentId, url, quote, canRefresh }: { appointmentId: string; url: string; quote: QuoteDTO | null; canRefresh: boolean }) {
  const t = useT();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const prices = quote?.items.some((i) => i.unit || i.total) ?? false;
  return (
    <Card>
      <CardHeader
        title={quote?.number ? `${t("quote.title")} · ${quote.number}` : t("quote.title")}
        icon={<FileText className="h-4 w-4" />}
        actions={
          <>
            <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm text-brand-text hover:underline">
              {t("quote.open")} <ExternalLink className="h-3.5 w-3.5" />
            </a>
            {canRefresh && (
              <Button
                size="sm"
                variant="ghost"
                loading={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await api(`/api/appointments/${appointmentId}/quote`, { method: "POST", body: { url } });
                    toast.success(t("quote.refreshed"));
                    router.refresh();
                  } catch (e) {
                    toast.error(e instanceof ApiError ? e.message : t("common.couldNotSave"));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <RefreshCw className="h-4 w-4" /> {t("quote.refresh")}
              </Button>
            )}
          </>
        }
      />
      {quote ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-line bg-surface-muted text-xs text-fg-muted">
              <tr>
                <th scope="col" className="px-4 py-2 text-start font-medium">
                  {t("quote.item")}
                </th>
                <th scope="col" className="px-3 py-2 text-start font-medium">
                  {t("quote.qty")}
                </th>
                {prices && (
                  <>
                    <th scope="col" className="px-3 py-2 text-start font-medium">
                      {t("quote.unit")}
                    </th>
                    <th scope="col" className="px-3 py-2 text-start font-medium">
                      {t("quote.total")}
                    </th>
                  </>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {quote.items.map((i, k) => (
                <tr key={k}>
                  <td className="px-4 py-2 text-fg">
                    <span dir="auto">{i.name}</span>
                    {(i.sku || i.spec) && <span className="block text-xs text-fg-muted">{[i.sku, i.spec].filter(Boolean).join(" · ")}</span>}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-fg-muted">{i.qty}</td>
                  {prices && (
                    <>
                      <td className="px-3 py-2 tabular-nums text-fg-muted">{i.unit ?? ""}</td>
                      <td className="px-3 py-2 tabular-nums text-fg-muted">{i.total ?? ""}</td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {(quote.total || quote.install) && (
            <p className="border-t border-line px-4 py-2 text-sm text-fg">
              {quote.total && t("quote.grandTotal", { total: quote.total })}
              {quote.install && ` · ${t("quote.installation", { amount: quote.install })}`}
            </p>
          )}
        </div>
      ) : (
        <p className="px-5 py-4 text-sm text-fg-subtle">{t("quote.notRead")}</p>
      )}
    </Card>
  );
}
