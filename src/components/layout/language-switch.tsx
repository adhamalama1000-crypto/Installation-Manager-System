"use client";

import { useState } from "react";
import { Languages } from "lucide-react";
import { useT } from "@/i18n/client";
import type { Locale } from "@/i18n/config";
import { cn } from "@/lib/utils";

/** Arabic / English switch. Reloads the page so every part (dates, direction) follows. */
export function LanguageSwitch({ className }: { className?: string }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const choose = async (locale: Locale) => {
    if (locale === t.locale || busy) return;
    setBusy(true);
    try {
      await fetch("/api/me/locale", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ locale }) });
    } finally {
      window.location.reload();
    }
  };
  const options: { value: Locale; label: string }[] = [
    { value: "ar", label: t("common.arabic") },
    { value: "en", label: t("common.english") },
  ];
  return (
    <div className={cn("inline-flex items-center gap-1 rounded-lg border border-line bg-surface-muted p-0.5", className)} role="radiogroup" aria-label={t("common.language")}>
      <Languages className="mx-1 h-4 w-4 text-fg-subtle" aria-hidden />
      {options.map(({ value, label }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={t.locale === value}
          lang={value}
          disabled={busy}
          onClick={() => choose(value)}
          className={cn(
            "h-7 rounded-md px-2 text-xs font-medium transition-colors",
            t.locale === value ? "bg-surface text-brand-text shadow-card" : "text-fg-subtle hover:text-fg",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
