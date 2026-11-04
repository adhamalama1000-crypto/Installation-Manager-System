"use client";

import { History } from "lucide-react";
import { useT } from "@/i18n/client";
import { fmt } from "@/lib/time";
import { Button } from "./button";

/** Offers a draft kept in this browser from an earlier visit: restore it or throw it away. */
export function DraftBanner({ at, onRestore, onDiscard, timezone }: { at: string; onRestore: () => void; onDiscard: () => void; timezone: string }) {
  const t = useT();
  return (
    <div role="status" className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface-muted px-4 py-3 text-sm">
      <History className="h-4 w-4 shrink-0 text-fg-subtle" aria-hidden />
      <span className="min-w-0 flex-1">{t("drafts.found", { when: fmt(new Date(at), timezone, "d MMM, HH:mm", t.locale) })}</span>
      <Button type="button" size="sm" variant="secondary" onClick={onRestore}>
        {t("drafts.restore")}
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={onDiscard}>
        {t("drafts.discard")}
      </Button>
    </div>
  );
}
