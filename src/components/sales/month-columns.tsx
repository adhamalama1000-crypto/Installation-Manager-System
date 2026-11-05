"use client";

import { useState } from "react";
import { useT } from "@/i18n/client";
import { intlLocale } from "@/i18n/config";
import { money } from "@/lib/constants";

type Series = { key: string; label: string; values: number[]; color: string };

/**
 * Monthly columns for one or two series (this year and last year). Columns are at most 24 px wide
 * with a 4 px rounded cap and a 2 px gap between a month's pair; a legend names the series when
 * there are two; hovering or focusing a month shows its values; the same numbers are in the table
 * below the chart (open "Show as a table"), so nothing depends on colour or hovering.
 */
export function MonthColumns({ months, series, valueKind = "money", emptyText, title }: { months: string[]; series: Series[]; valueKind?: "money" | "number"; emptyText: string; title: string }) {
  const t = useT();
  const format = (n: number) => (valueKind === "money" ? money(n, t.locale) : new Intl.NumberFormat(intlLocale(t.locale), { maximumFractionDigits: 3 }).format(n));
  const formatTick = (n: number) => new Intl.NumberFormat(intlLocale(t.locale), { notation: "compact", maximumFractionDigits: 1 }).format(n);
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(0, ...series.flatMap((s) => s.values));
  if (max <= 0) return <p className="py-6 text-center text-sm text-fg-muted">{emptyText}</p>;
  // Clean ticks: 0, a half and the top, rounded.
  const pow = 10 ** Math.floor(Math.log10(max));
  const top = Math.ceil(max / pow) * pow;
  const ticks = [top, top / 2, 0];
  const height = 160;
  return (
    <figure className="space-y-3">
      {series.length > 1 && (
        <ul className="flex flex-wrap gap-4 text-xs text-fg-muted" aria-label={title}>
          {series.map((s) => (
            <li key={s.key} className="flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: s.color }} aria-hidden />
              {s.label}
            </li>
          ))}
        </ul>
      )}
      <div className="relative flex gap-2" dir="ltr">
        <div className="flex w-12 shrink-0 flex-col justify-between text-end text-[11px] tabular-nums text-fg-subtle" style={{ height }} aria-hidden>
          {ticks.map((v) => (
            <span key={v} className="-translate-y-1/2 first:translate-y-0 last:translate-y-0">
              {formatTick(v)}
            </span>
          ))}
        </div>
        <div className="relative min-w-0 flex-1">
          {ticks.map((v) => (
            <div key={v} className="absolute inset-x-0 border-t border-line" style={{ top: height - (v / top) * height }} aria-hidden />
          ))}
          <div className="relative flex items-end justify-between" style={{ height }}>
            {months.map((m, i) => (
              <button
                key={m}
                type="button"
                className="group relative flex h-full flex-1 items-end justify-center gap-[2px] outline-none focus-visible:bg-surface-muted"
                onPointerEnter={() => setHover(i)}
                onPointerLeave={() => setHover((h) => (h === i ? null : h))}
                onFocus={() => setHover(i)}
                onBlur={() => setHover((h) => (h === i ? null : h))}
                aria-label={`${m}: ${series.map((s) => `${s.label} ${format(s.values[i] ?? 0)}`).join(", ")}`}
              >
                {series.map((s) => {
                  const v = s.values[i] ?? 0;
                  const h = v > 0 ? Math.max(2, (v / top) * height) : 0;
                  return <span key={s.key} className="block w-full max-w-[24px] rounded-t-[4px] transition-opacity" style={{ height: h, backgroundColor: s.color, opacity: hover === null || hover === i ? 1 : 0.45 }} aria-hidden />;
                })}
                {hover === i && (
                  <span role="tooltip" className="pointer-events-none absolute bottom-full z-10 mb-1 whitespace-nowrap rounded-md border border-line bg-surface px-2 py-1 text-start text-xs shadow-pop">
                    <span className="block font-medium text-fg-muted">{m}</span>
                    {series.map((s) => (
                      <span key={s.key} className="flex items-center gap-1.5">
                        <span className="inline-block h-0.5 w-3 rounded" style={{ backgroundColor: s.color }} aria-hidden />
                        <span className="font-semibold tabular-nums text-fg">{format(s.values[i] ?? 0)}</span>
                        {series.length > 1 && <span className="text-fg-subtle">{s.label}</span>}
                      </span>
                    ))}
                  </span>
                )}
              </button>
            ))}
          </div>
          <div className="mt-1 flex justify-between text-[11px] text-fg-subtle" aria-hidden>
            {months.map((m) => (
              <span key={m} className="flex-1 text-center">
                {m}
              </span>
            ))}
          </div>
        </div>
      </div>
      <details className="text-sm">
        <summary className="cursor-pointer text-xs text-brand-text">{t("charts.showTable")}</summary>
        <table className="mt-2 w-full text-xs">
          <caption className="sr-only">{title}</caption>
          <thead>
            <tr className="text-fg-muted">
              <th className="py-1 text-start font-medium">{t("analytics.month")}</th>
              {series.map((s) => (
                <th key={s.key} className="py-1 text-end font-medium">
                  {s.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {months.map((m, i) => (
              <tr key={m}>
                <td className="py-1">{m}</td>
                {series.map((s) => (
                  <td key={s.key} className="py-1 text-end tabular-nums">
                    {format(s.values[i] ?? 0)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
