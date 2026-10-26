"use client";

import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { useI18n } from "@/i18n/client";
import { cn } from "@/lib/utils";

type Theme = "light" | "dark" | "system";

function apply(theme: Theme) {
  const dark = theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

export function ThemeToggle({ className }: { className?: string }) {
  const { t } = useI18n();
  const [theme, setTheme] = useState<Theme>("system");
  useEffect(() => {
    try {
      const saved = localStorage.getItem("ims-theme") as Theme | null;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reading the stored preference after mount
      if (saved) setTheme(saved);
    } catch {}
  }, []);
  const choose = (t: Theme) => {
    setTheme(t);
    try {
      localStorage.setItem("ims-theme", t);
    } catch {}
    apply(t);
  };
  const options: { value: Theme; label: string; icon: typeof Sun }[] = [
    { value: "light", label: t("theme.light"), icon: Sun },
    { value: "dark", label: t("theme.dark"), icon: Moon },
    { value: "system", label: t("theme.system"), icon: Monitor },
  ];
  return (
    <div className={cn("inline-flex rounded-lg border border-line bg-surface-muted p-0.5", className)} role="radiogroup" aria-label={t("theme.label")}>
      {options.map(({ value, label, icon: Icon }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={theme === value}
          title={label}
          onClick={() => choose(value)}
          className={cn(
            "flex h-7 w-8 items-center justify-center rounded-md text-fg-subtle transition-colors",
            theme === value ? "bg-surface text-brand-text shadow-card" : "hover:text-fg",
          )}
        >
          <Icon className="h-4 w-4" />
          <span className="sr-only">{label}</span>
        </button>
      ))}
    </div>
  );
}
