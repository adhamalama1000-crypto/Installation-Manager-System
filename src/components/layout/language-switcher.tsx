"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Languages } from "lucide-react";
import { LOCALES, LOCALE_NAMES, dirOf, type Locale } from "@/i18n/config";
import { useI18n } from "@/i18n/client";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";

/**
 * Switches between Arabic and English. The choice is saved on the account (and this device), and
 * the page re-renders in place: what is typed in open forms is kept.
 */
export function LanguageSwitcher({ className, compact }: { className?: string; compact?: boolean }) {
  const { locale, t } = useI18n();
  const router = useRouter();
  const [pending, start] = useTransition();

  const choose = (next: Locale) => {
    if (next === locale || pending) return;
    start(async () => {
      try {
        await api("/api/locale", { method: "POST", body: { locale: next } });
      } catch {
        return;
      }
      document.documentElement.lang = next;
      document.documentElement.dir = dirOf(next);
      router.refresh();
    });
  };

  return (
    <div
      className={cn("inline-flex items-center gap-1 rounded-lg border border-line bg-surface-muted p-0.5", pending && "opacity-60", className)}
      role="radiogroup"
      aria-label={t("lang.label")}
    >
      {!compact && <Languages className="mx-1 h-4 w-4 text-fg-subtle" aria-hidden />}
      {LOCALES.map((l) => (
        <button
          key={l}
          type="button"
          role="radio"
          aria-checked={locale === l}
          lang={l}
          onClick={() => choose(l)}
          className={cn(
            "h-7 rounded-md px-2 text-xs font-medium transition-colors",
            locale === l ? "bg-surface text-brand-text shadow-card" : "text-fg-subtle hover:text-fg",
          )}
        >
          {LOCALE_NAMES[l]}
        </button>
      ))}
    </div>
  );
}
