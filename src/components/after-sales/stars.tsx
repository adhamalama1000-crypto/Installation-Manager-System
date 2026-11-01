"use client";

import { Star } from "lucide-react";
import { useT } from "@/i18n/client";
import { cn } from "@/lib/utils";

/** 1-5 star input (a radio group: arrow keys move, Space/Enter pick) or a read-only display. */
export function Stars({ value, onChange, label, disabled, size = "md" }: { value: number | null; onChange?: (n: number) => void; label: string; disabled?: boolean; size?: "sm" | "md" }) {
  const t = useT();
  const icon = size === "sm" ? "h-4 w-4" : "h-6 w-6";
  if (!onChange) {
    return (
      <span className="inline-flex items-center gap-0.5" role="img" aria-label={value ? `${label}: ${t("afterSales.stars", { count: value })}` : label}>
        {[1, 2, 3, 4, 5].map((n) => (
          <Star key={n} className={cn(icon, n <= (value ?? 0) ? "fill-warning text-warning" : "text-line-strong")} aria-hidden />
        ))}
      </span>
    );
  }
  return (
    <span role="radiogroup" aria-label={label} className="inline-flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          aria-label={t("afterSales.stars", { count: n })}
          tabIndex={value === n || (!value && n === 1) ? 0 : -1}
          disabled={disabled}
          onClick={() => onChange(n)}
          onKeyDown={(e) => {
            const forward = e.key === "ArrowUp" || (document.documentElement.dir === "rtl" ? e.key === "ArrowLeft" : e.key === "ArrowRight");
            const back = e.key === "ArrowDown" || (document.documentElement.dir === "rtl" ? e.key === "ArrowRight" : e.key === "ArrowLeft");
            if (!forward && !back) return;
            e.preventDefault();
            const next = Math.min(5, Math.max(1, (value ?? 0) + (forward ? 1 : -1)));
            onChange(next);
            (e.currentTarget.parentElement?.children[next - 1] as HTMLElement | undefined)?.focus();
          }}
          className="rounded p-0.5 focus-visible:outline-2 focus-visible:outline-brand disabled:opacity-50"
        >
          <Star className={cn(icon, n <= (value ?? 0) ? "fill-warning text-warning" : "text-line-strong hover:text-warning")} aria-hidden />
        </button>
      ))}
    </span>
  );
}
