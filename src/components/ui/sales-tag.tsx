"use client";

import { useI18n } from "@/i18n/client";
import { colorOrFallback } from "@/lib/colors";
import { cn } from "@/lib/utils";

/** Sales employee colour marker + name. */
export function SalesTag({ name, color, inactive, className }: { name: string; color: string | null; inactive?: boolean; className?: string }) {
  const { t } = useI18n();
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-sm text-fg", className)}>
      <span className="h-3 w-3 shrink-0 rounded-full ring-1 ring-black/10 dark:ring-white/20" style={{ backgroundColor: colorOrFallback(color) }} aria-hidden />
      <span className="truncate">{name}</span>
      {inactive && <span className="text-xs text-fg-subtle">{t("common.inactiveParen")}</span>}
    </span>
  );
}
