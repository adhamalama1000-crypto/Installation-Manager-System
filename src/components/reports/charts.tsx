import { colorOrFallback } from "@/lib/colors";
import { cn } from "@/lib/utils";

export function StatTile({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4 shadow-card">
      <p className="text-sm text-fg-muted">{label}</p>
      <p className="mt-1 text-3xl font-semibold tabular-nums text-fg">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-fg-subtle">{sub}</p>}
    </div>
  );
}

/**
 * Horizontal bars with the label and value as text (identity never relies on colour alone).
 * Each row is also a readable table row for screen readers.
 */
export function BarList({
  rows,
  unit = "",
  emptyText,
}: {
  rows: { key: string; label: React.ReactNode; value: number; color?: string | null; display?: string }[];
  unit?: string;
  emptyText: string;
}) {
  if (!rows.length) return <p className="py-6 text-center text-sm text-fg-muted">{emptyText}</p>;
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <table className="w-full text-sm">
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} className="group" title={`${typeof r.label === "string" ? r.label : ""} ${r.display ?? r.value}${unit}`}>
            <th scope="row" className="w-[38%] max-w-0 py-1.5 pe-3 text-start font-normal text-fg">
              <span className="flex items-center gap-2 truncate">
                {r.color && <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: colorOrFallback(r.color) }} aria-hidden />}
                <span className="truncate">{r.label}</span>
              </span>
            </th>
            <td className="py-1.5">
              <div className="flex items-center gap-2">
                <div className="h-5 flex-1">
                  <div
                    className="h-full rounded-e-[4px] transition-[filter] group-hover:brightness-110"
                    style={{ width: `${Math.max((r.value / max) * 100, r.value > 0 ? 1.5 : 0)}%`, backgroundColor: r.color ? colorOrFallback(r.color) : "var(--brand)" }}
                  />
                </div>
                <span className="w-14 shrink-0 text-end font-medium tabular-nums text-fg">
                  {r.display ?? r.value}
                  {unit}
                </span>
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Daily column chart (single series) with a hover/focus tooltip per column. */
export function DailyColumns({
  days,
  labelFor,
  columnLabel,
  emptyText,
}: {
  days: { day: string; count: number }[];
  labelFor: (day: string) => string;
  /** Accessible name of one column ("Sat 14 Mar: 3 appointments"). */
  columnLabel: (day: string, count: number) => string;
  emptyText: string;
}) {
  if (!days.some((d) => d.count > 0)) return <p className="py-6 text-center text-sm text-fg-muted">{emptyText}</p>;
  const max = Math.max(...days.map((d) => d.count), 1);
  const ticks = [max, Math.round(max / 2), 0].filter((v, i, a) => a.indexOf(v) === i);
  return (
    <div>
      <div className="flex h-48 gap-2">
        <div className="flex flex-col justify-between py-0.5 text-end text-[11px] tabular-nums text-fg-subtle" aria-hidden>
          {ticks.map((t) => (
            <span key={t}>{t}</span>
          ))}
        </div>
        <div className="relative flex flex-1 items-end gap-[2px] border-b border-line">
          {ticks.map((t) => (
            <div key={t} className="pointer-events-none absolute inset-x-0 border-t border-line/60" style={{ bottom: `${(t / max) * 100}%` }} aria-hidden />
          ))}
          {days.map((d) => (
            <div key={d.day} tabIndex={0} className="group relative flex h-full flex-1 items-end outline-none" aria-label={columnLabel(d.day, d.count)}>
              <div
                className={cn("w-full max-w-6 mx-auto rounded-t-[4px] bg-brand transition-[filter] group-hover:brightness-110 group-focus:brightness-110")}
                style={{ height: `${(d.count / max) * 100}%`, minHeight: d.count ? 2 : 0 }}
              />
              <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 whitespace-nowrap rounded-md border border-line bg-surface px-2 py-1 text-xs shadow-pop group-hover:block group-focus:block">
                <span className="font-medium text-fg">{d.count}</span> <span className="text-fg-muted">· {labelFor(d.day)}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="ms-6 mt-1 flex justify-between text-[11px] text-fg-subtle" aria-hidden>
        <span>{labelFor(days[0]!.day)}</span>
        {days.length > 1 && <span>{labelFor(days[days.length - 1]!.day)}</span>}
      </div>
    </div>
  );
}
