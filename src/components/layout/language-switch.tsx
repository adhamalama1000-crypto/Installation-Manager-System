"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Languages } from "lucide-react";
import { toast } from "sonner";
import { useT } from "@/i18n/client";
import { dirOf, type Locale } from "@/i18n/config";
import { cn } from "@/lib/utils";

/**
 * Arabic / English switch. The page re-renders in place in the new language and direction, so
 * whatever is typed in an open form is kept (no full reload).
 */
export function LanguageSwitch({ className }: { className?: string }) {
  const t = useT();
  const router = useRouter();
  const [busy, start] = useTransition();
  const choose = (locale: Locale) => {
    if (locale === t.locale || busy) return;
    start(async () => {
      let ok = false;
      try {
        const res = await fetch("/api/me/locale", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ locale }) });
        ok = res.ok;
      } catch {
        ok = false;
      }
      if (!ok) {
        toast.error(t("errors.network"));
        return;
      }
      // Direction first, so the layout flips at once; the server then sends the page in the new language.
      document.documentElement.lang = locale;
      document.documentElement.dir = dirOf(locale);
      router.refresh();
    });
  };
  const options: { value: Locale; label: string }[] = [
    { value: "ar", label: t("common.arabic") },
    { value: "en", label: t("common.english") },
  ];
  return (
    <div className={cn("inline-flex items-center gap-1 rounded-lg border border-line bg-surface-muted p-0.5", busy && "opacity-60", className)} role="radiogroup" aria-label={t("common.language")}>
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
