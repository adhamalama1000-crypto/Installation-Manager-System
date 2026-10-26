"use client";

import { memo, startTransition, useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, ExternalLink, Loader2, MapPin, Plus, RefreshCw, Users, X } from "lucide-react";
import { useT } from "@/i18n/client";
import type { Locale } from "@/i18n/config";
import type { MessageKey } from "@/i18n/translator";
import { apiIfChanged, ApiError } from "@/lib/api-client";
import { chipColors, colorOrFallback } from "@/lib/colors";
import { productLine, timeRange } from "@/lib/format";
import {
  addDaysToKey,
  addMonthsToKey,
  dateKey,
  formatKey,
  minutesOfDay,
  startOfMonthKey,
  startOfWeekKey,
  todayKey,
} from "@/lib/time";
import type { AppointmentListItem, StatusDTO } from "@/lib/types";
import { Alert, SalesTag, StatusBadge } from "@/components/ui/misc";
import { buttonClasses } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type CalendarViewMode = "month" | "week" | "day" | "agenda";

type Person = { id: string; name: string; color?: string | null; isActive?: boolean };

const HOUR_PX = 56;
const VIEWS: { id: CalendarViewMode; label: MessageKey }[] = [
  { id: "day", label: "calendar.day" },
  { id: "week", label: "calendar.week" },
  { id: "month", label: "calendar.month" },
  { id: "agenda", label: "calendar.agenda" },
];

function rangeFor(view: CalendarViewMode, date: string, weekStartsOn: number) {
  switch (view) {
    case "day":
      return { from: date, to: date };
    case "week": {
      const from = startOfWeekKey(date, weekStartsOn);
      return { from, to: addDaysToKey(from, 6) };
    }
    case "month": {
      const from = startOfWeekKey(startOfMonthKey(date), weekStartsOn);
      return { from, to: addDaysToKey(from, 41) };
    }
    case "agenda":
      return { from: date, to: addDaysToKey(date, 13) };
  }
}

function titleFor(view: CalendarViewMode, date: string, weekStartsOn: number, locale: Locale) {
  if (view === "month") return formatKey(date, { month: "long", year: "numeric" }, locale);
  if (view === "day") return formatKey(date, { weekday: "long", day: "numeric", month: "long", year: "numeric" }, locale);
  const r = rangeFor(view, date, weekStartsOn);
  return `${formatKey(r.from, { day: "numeric", month: "short" }, locale)} – ${formatKey(r.to, { day: "numeric", month: "short", year: "numeric" }, locale)}`;
}

function shift(view: CalendarViewMode, date: string, dir: 1 | -1) {
  if (view === "month") return addMonthsToKey(date, dir);
  if (view === "week") return addDaysToKey(date, 7 * dir);
  if (view === "agenda") return addDaysToKey(date, 14 * dir);
  return addDaysToKey(date, dir);
}

function daysBetween(from: string, to: string) {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDaysToKey(d, 1)) out.push(d);
  return out;
}

/** An event with its local day keys, minutes and time label worked out once (not per render/day). */
type CalEvent = { a: AppointmentListItem; startKey: string; endKey: string; startMin: number; endMin: number; time: string };
/** An event on one local day, with start/end minutes clipped to that day. */
type DayItem = { e: AppointmentListItem; time: string; start: number; end: number };

function prepareEvents(events: AppointmentListItem[], tz: string): CalEvent[] {
  return events.map((a) => ({
    a,
    startKey: dateKey(a.startsAt, tz),
    endKey: dateKey(new Date(new Date(a.endsAt).getTime() - 1), tz),
    startMin: minutesOfDay(a.startsAt, tz),
    endMin: minutesOfDay(a.endsAt, tz),
    time: timeRange(a.startsAt, a.endsAt, tz),
  }));
}

/** Events touching each day of `days`, sorted by start (longer first on ties). */
function eventsByDay(events: CalEvent[], days: string[]): Map<string, DayItem[]> {
  const out = new Map<string, DayItem[]>(days.map((d) => [d, []]));
  const first = days[0];
  const last = days[days.length - 1];
  if (!first || !last) return out;
  for (const ev of events) {
    if (ev.endKey < first || ev.startKey > last) continue;
    const to = ev.endKey > last ? last : ev.endKey;
    for (let d = ev.startKey < first ? first : ev.startKey; d <= to; d = addDaysToKey(d, 1)) {
      const start = ev.startKey < d ? 0 : ev.startMin;
      const end = ev.endKey > d ? 1440 : ev.endMin || 1440;
      out.get(d)?.push({ e: ev.a, time: ev.time, start, end: Math.max(end, start + 15) });
    }
  }
  for (const list of out.values()) list.sort((a, b) => a.start - b.start || b.end - a.end);
  return out;
}

/** Side-by-side columns for overlapping events (classic calendar layout). */
function layoutDay(items: DayItem[]) {
  const out: { item: (typeof items)[number]; col: number; cols: number }[] = [];
  let cluster: { item: (typeof items)[number]; col: number }[] = [];
  let clusterEnd = -1;
  const flush = () => {
    const cols = Math.max(1, ...cluster.map((c) => c.col + 1));
    for (const c of cluster) out.push({ ...c, cols });
    cluster = [];
  };
  for (const item of items) {
    if (item.start >= clusterEnd && cluster.length) flush();
    const used = new Set(cluster.filter((c) => c.item.end > item.start).map((c) => c.col));
    let col = 0;
    while (used.has(col)) col++;
    cluster.push({ item, col });
    clusterEnd = Math.max(clusterEnd, item.end);
  }
  if (cluster.length) flush();
  return out;
}

export function CalendarView({
  tz,
  weekStartsOn,
  dayStartHour,
  dayEndHour,
  initialView,
  initialDate,
  initialFilters,
  sales,
  technicians,
  statuses,
  canCreate,
  isTechnician,
}: {
  tz: string;
  weekStartsOn: number;
  dayStartHour: number;
  dayEndHour: number;
  initialView: CalendarViewMode | null;
  initialDate: string;
  initialFilters: { salesId?: string; technicianId?: string; status?: string };
  sales: Person[];
  technicians: Person[];
  statuses: StatusDTO[];
  canCreate: boolean;
  isTechnician: boolean;
}) {
  const t = useT();
  const [view, setView] = useState<CalendarViewMode>(initialView ?? "week");
  const [date, setDate] = useState(initialDate);
  const [filters, setFilters] = useState(initialFilters);
  const [events, setEvents] = useState<AppointmentListItem[]>([]);
  const [loading, setLoading] = useState(true);
  // Redrawing a busy month or agenda is heavy; doing it in a transition keeps the page responsive.
  const [rendering, startRender] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<AppointmentListItem | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [now, setNow] = useState(() => new Date());

  // Small screens start in the agenda view unless a view was requested explicitly.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- viewport-dependent default
    if (!initialView && window.matchMedia("(max-width: 767px)").matches) setView("agenda");
  }, [initialView]);

  const range = useMemo(() => rangeFor(view, date, weekStartsOn), [view, date, weekStartsOn]);

  // Keep the URL in sync so a view can be bookmarked or shared.
  useEffect(() => {
    const p = new URLSearchParams({ view, date });
    for (const [k, v] of Object.entries(filters)) if (v) p.set(k, v);
    window.history.replaceState(null, "", `?${p.toString()}`);
  }, [view, date, filters]);

  // Version of the events on screen, so the 30-second poll only downloads and re-renders changes.
  const loaded = useRef<{ url: string; etag: string | null }>({ url: "", etag: null });

  const load = useCallback(
    async (signal?: AbortSignal, quiet = false) => {
      if (!quiet) setLoading(true);
      try {
        const p = new URLSearchParams({ from: range.from, to: range.to });
        for (const [k, v] of Object.entries(filters)) if (v) p.set(k, v);
        const url = `/api/calendar?${p.toString()}`;
        const known = quiet && loaded.current.url === url ? loaded.current.etag : null;
        const res = await apiIfChanged<{ events: AppointmentListItem[] }>(url, known, signal);
        const fresh = res.data?.events;
        if (fresh) startTransition(() => setEvents(fresh));
        loaded.current = { url, etag: res.etag };
        setError(null);
        setLastUpdated(new Date());
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        setError(e instanceof ApiError ? e.message : t("calendar.loadError"));
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [range.from, range.to, filters, t],
  );

  useEffect(() => {
    const ctrl = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetching external data for the visible range
    void load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  // Poll for changes made by other users; refresh immediately when the tab becomes visible.
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") {
        void load(undefined, true);
        setNow(new Date());
      }
    };
    const timer = setInterval(tick, 30_000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [load]);

  const today = todayKey(tz, now);
  const days = useMemo(() => daysBetween(range.from, range.to), [range.from, range.to]);
  const prepared = useMemo(() => prepareEvents(events, tz), [events, tz]);
  const byDay = useMemo(() => eventsByDay(prepared, days), [prepared, days]);

  const visibleHours = useMemo(() => {
    let start = dayStartHour;
    let end = dayEndHour;
    if (view === "day" || view === "week") {
      for (const list of byDay.values()) {
        for (const it of list) {
          start = Math.min(start, Math.floor(it.start / 60));
          end = Math.max(end, Math.ceil(it.end / 60));
        }
      }
    }
    return { start, end: Math.min(24, Math.max(end, start + 1)) };
  }, [byDay, view, dayStartHour, dayEndHour]);

  const setFilter = (k: keyof typeof filters, v: string) => setFilters((f) => ({ ...f, [k]: v || undefined }));
  const openDay = useCallback((d: string) => {
    startTransition(() => {
      setDate(d);
      setView("day");
    });
  }, []);

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg border border-line bg-surface shadow-card">
            <button type="button" onClick={() => startRender(() => setDate(shift(view, date, -1)))} className="rounded-s-lg px-2.5 py-2 text-fg-muted hover:bg-surface-muted" aria-label={t("common.previous")}>
              <ChevronLeft className="h-4 w-4 rtl:rotate-180" />
            </button>
            <button type="button" onClick={() => startRender(() => setDate(today))} className="border-x border-line px-3 text-sm font-medium hover:bg-surface-muted">
              {t("common.today")}
            </button>
            <button type="button" onClick={() => startRender(() => setDate(shift(view, date, 1)))} className="rounded-e-lg px-2.5 py-2 text-fg-muted hover:bg-surface-muted" aria-label={t("common.next")}>
              <ChevronRight className="h-4 w-4 rtl:rotate-180" />
            </button>
          </div>
          <h2 className="text-lg font-semibold text-fg" aria-live="polite">
            {titleFor(view, date, weekStartsOn, t.locale)}
          </h2>
          {(loading || rendering) && <Loader2 className="h-4 w-4 animate-spin text-fg-subtle" aria-label={t("common.loading")} />}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-lg border border-line bg-surface-muted p-0.5" role="tablist" aria-label={t("calendar.view")}>
            {VIEWS.map((v) => (
              <button
                key={v.id}
                type="button"
                role="tab"
                aria-selected={view === v.id}
                onClick={() => startRender(() => setView(v.id))}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                  view === v.id ? "bg-surface text-brand-text shadow-card" : "text-fg-muted hover:text-fg",
                )}
              >
                {t(v.label)}
              </button>
            ))}
          </div>
          <button type="button" onClick={() => load()} className={buttonClasses("outline", "icon")} title={t("calendar.refresh")}>
            <RefreshCw className="h-4 w-4" />
            <span className="sr-only">{t("calendar.refresh")}</span>
          </button>
          {canCreate && (
            <Link href={`/appointments/new?date=${date}`} className={buttonClasses("primary")}>
              <Plus className="h-4 w-4" /> {t("nav.newShort")}
            </Link>
          )}
        </div>
      </div>

      {/* Filters + Sales colour legend */}
      <div className="rounded-xl border border-line bg-surface p-3 shadow-card">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex flex-wrap items-center gap-x-1 gap-y-1.5" aria-label={t("calendar.legend")}>
            <span className="me-1 text-xs font-semibold uppercase tracking-wide text-fg-subtle">{t("common.sales")}</span>
            {sales.map((s) => {
              const active = filters.salesId === s.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setFilter("salesId", active ? "" : s.id)}
                  aria-pressed={active}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                    active ? "border-fg bg-surface-muted text-fg" : "border-transparent text-fg-muted hover:bg-surface-muted",
                    filters.salesId && !active && "opacity-50",
                  )}
                  title={active ? t("calendar.showAllSales") : t("calendar.showOnly", { name: s.name })}
                >
                  <span className="h-3 w-3 rounded-full ring-1 ring-black/10 dark:ring-white/20" style={{ backgroundColor: colorOrFallback(s.color) }} aria-hidden />
                  {s.name}
                  {s.isActive === false && <span className="text-fg-subtle">{t("common.inactiveParen")}</span>}
                </button>
              );
            })}
          </div>
          <div className="flex flex-wrap gap-2">
            {!isTechnician && (
              <select
                aria-label={t("calendar.filterTechnician")}
                value={filters.technicianId ?? ""}
                onChange={(e) => setFilter("technicianId", e.target.value)}
                className="h-9 rounded-lg border border-line-strong bg-surface px-2 text-sm"
              >
                <option value="">{t("filters.allTechnicians")}</option>
                {technicians.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                    {x.isActive === false ? ` ${t("common.inactiveParen")}` : ""}
                  </option>
                ))}
              </select>
            )}
            <select
              aria-label={t("calendar.filterStatus")}
              value={filters.status ?? ""}
              onChange={(e) => setFilter("status", e.target.value)}
              className="h-9 rounded-lg border border-line-strong bg-surface px-2 text-sm"
            >
              <option value="">{t("filters.allStatuses")}</option>
              {statuses.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {error && (
        <Alert tone="danger" title={t("calendar.loadErrorTitle")}>
          {error}
        </Alert>
      )}

      <div className="overflow-hidden rounded-xl border border-line bg-surface shadow-card">
        {view === "month" && (
          <MonthGrid days={days} month={date.slice(0, 7)} today={today} byDay={byDay} onSelect={setSelected} onDay={openDay} canCreate={canCreate} />
        )}
        {(view === "week" || view === "day") && (
          <TimeGrid days={days} today={today} byDay={byDay} tz={tz} hours={visibleHours} detailed={view === "day"} onSelect={setSelected} now={now} canCreate={canCreate} onDay={openDay} />
        )}
        {view === "agenda" && <Agenda days={days} today={today} events={prepared} onSelect={setSelected} />}
      </div>
      <p className="text-end text-xs text-fg-subtle">
        {t("calendar.timesIn", { tz })} {lastUpdated ? t("calendar.updated", { time: lastUpdated.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) }) : ""}
      </p>

      {selected && <DetailsPanel a={selected} tz={tz} onClose={() => setSelected(null)} />}
    </div>
  );
}

function EventChip({ a, time, onSelect, compact }: { a: AppointmentListItem; time: string; onSelect: (a: AppointmentListItem) => void; compact?: boolean }) {
  const cancelled = a.status.kind === "CANCELLED";
  return (
    <button
      type="button"
      onClick={() => onSelect(a)}
      className={cn("block w-full truncate rounded px-1.5 py-0.5 text-start text-[11px] font-medium leading-4", cancelled && "line-through opacity-50")}
      style={chipColors(a.createdBy.color)}
      title={`${time} ${a.customerName} (${a.status.name})`}
    >
      {!compact && <span className="tabular-nums opacity-90">{time.split("–")[0]} </span>}
      {a.customerName}
    </button>
  );
}

// Memoised: the grids only re-render when their own inputs change (not on every poll or click).
const MonthGrid = memo(function MonthGrid({
  days,
  month,
  today,
  byDay,
  onSelect,
  onDay,
  canCreate,
}: {
  days: string[];
  month: string;
  today: string;
  byDay: Map<string, DayItem[]>;
  onSelect: (a: AppointmentListItem) => void;
  onDay: (d: string) => void;
  canCreate: boolean;
}) {
  const t = useT();
  return (
    <div>
      <div className="grid grid-cols-7 border-b border-line bg-surface-muted/60">
        {days.slice(0, 7).map((d) => (
          <div key={d} className="px-2 py-2 text-center text-xs font-semibold uppercase tracking-wide text-fg-subtle">
            <span className="hidden sm:inline">{formatKey(d, { weekday: "short" }, t.locale)}</span>
            <span className="sm:hidden">{formatKey(d, { weekday: "narrow" }, t.locale)}</span>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {days.map((d) => {
          const list = byDay.get(d) ?? [];
          const inMonth = d.startsWith(month);
          const max = 3;
          return (
            <div key={d} className={cn("group relative min-h-24 border-b border-e border-line p-1 sm:min-h-28 sm:p-1.5 [&:nth-child(7n)]:border-e-0", !inMonth && "bg-surface-muted/50")}>
              <div className="mb-1 flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => onDay(d)}
                  className={cn(
                    "flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-xs font-medium hover:bg-surface-hover",
                    d === today ? "bg-brand-strong text-white hover:bg-brand-stronger" : inMonth ? "text-fg" : "text-fg-subtle",
                  )}
                  aria-label={t("calendar.openDay", { day: formatKey(d, { weekday: "long", day: "numeric", month: "long" }, t.locale) })}
                >
                  {Number(d.slice(8))}
                </button>
                {canCreate && (
                  <Link href={`/appointments/new?date=${d}`} prefetch={false} className="rounded p-0.5 text-fg-subtle opacity-0 hover:bg-surface-hover hover:text-fg group-hover:opacity-100 focus:opacity-100" aria-label={t("calendar.newOn", { day: d })}>
                    <Plus className="h-3.5 w-3.5" />
                  </Link>
                )}
              </div>
              <div className="space-y-0.5">
                {/* On phones show coloured dots instead of text chips. */}
                <div className="flex flex-wrap gap-0.5 sm:hidden">
                  {list.map(({ e: a, time }) => (
                    <button key={a.id} type="button" onClick={() => onSelect(a)} className="h-2 w-2 rounded-full" style={{ backgroundColor: colorOrFallback(a.createdBy.color) }} aria-label={`${a.customerName} ${time}`} />
                  ))}
                </div>
                <div className="hidden space-y-0.5 sm:block">
                  {list.slice(0, max).map(({ e: a, time }) => (
                    <EventChip key={a.id} a={a} time={time} onSelect={onSelect} />
                  ))}
                  {list.length > max && (
                    <button type="button" onClick={() => onDay(d)} className="px-1.5 text-[11px] font-medium text-fg-muted hover:text-fg">
                      {t("calendar.more", { count: list.length - max })}
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
});

const TimeGrid = memo(function TimeGrid({
  days,
  today,
  byDay,
  tz,
  hours,
  detailed,
  onSelect,
  now,
  canCreate,
  onDay,
}: {
  days: string[];
  today: string;
  byDay: Map<string, DayItem[]>;
  tz: string;
  hours: { start: number; end: number };
  detailed: boolean;
  onSelect: (a: AppointmentListItem) => void;
  now: Date;
  canCreate: boolean;
  onDay: (d: string) => void;
}) {
  const t = useT();
  const hourList = Array.from({ length: hours.end - hours.start }, (_, i) => hours.start + i);
  const height = hourList.length * HOUR_PX;
  const nowMin = minutesOfDay(now, tz);
  return (
    <div className="overflow-x-auto">
      <div className={cn(!detailed && "min-w-[760px]")}>
        <div className="sticky top-0 z-10 grid border-b border-line bg-surface-muted/80 backdrop-blur" style={{ gridTemplateColumns: `56px repeat(${days.length}, minmax(0, 1fr))` }}>
          <div />
          {days.map((d) => (
            <button key={d} type="button" onClick={() => onDay(d)} className="border-s border-line px-2 py-2 text-center hover:bg-surface-hover">
              <span className="block text-xs font-semibold uppercase tracking-wide text-fg-subtle">{formatKey(d, { weekday: "short" }, t.locale)}</span>
              <span className={cn("mx-auto mt-0.5 flex h-7 w-7 items-center justify-center rounded-full text-sm font-semibold", d === today ? "bg-brand-strong text-white" : "text-fg")}>
                {Number(d.slice(8))}
              </span>
            </button>
          ))}
        </div>
        <div className="grid" style={{ gridTemplateColumns: `56px repeat(${days.length}, minmax(0, 1fr))` }}>
          <div className="relative" style={{ height }}>
            {hourList.map((h, i) => (
              <div key={h} className="absolute end-2 -translate-y-1/2 text-[11px] tabular-nums text-fg-subtle" style={{ top: i * HOUR_PX }}>
                {i === 0 ? "" : `${String(h).padStart(2, "0")}:00`}
              </div>
            ))}
          </div>
          {days.map((d) => {
            const items = layoutDay(byDay.get(d) ?? []);
            return (
              <div key={d} className={cn("relative border-s border-line", d === today && "bg-brand-soft/30")} style={{ height }}>
                {hourList.map((h, i) => (
                  <div key={h} className="absolute inset-x-0 border-t border-line/70" style={{ top: i * HOUR_PX }}>
                    {canCreate && (
                      <Link
                        href={`/appointments/new?date=${d}&time=${String(h).padStart(2, "0")}:00`}
                        prefetch={false}
                        className="block opacity-0 hover:bg-surface-muted/60 hover:opacity-100 focus:opacity-100"
                        style={{ height: HOUR_PX }}
                        aria-label={t("calendar.newAt", { day: d, time: `${h}:00` })}
                        tabIndex={-1}
                      />
                    )}
                  </div>
                ))}
                {items.map(({ item, col, cols }) => {
                  const a = item.e;
                  const time = item.time;
                  const top = ((item.start - hours.start * 60) / 60) * HOUR_PX;
                  const h = Math.max(((item.end - item.start) / 60) * HOUR_PX - 2, 20);
                  const cancelled = a.status.kind === "CANCELLED";
                  return (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => onSelect(a)}
                      className={cn(
                        "absolute overflow-hidden rounded-md border border-black/10 px-1.5 py-1 text-start text-xs shadow-sm transition-[filter] hover:brightness-95 focus-visible:z-20 dark:border-white/10",
                        cancelled && "opacity-50",
                      )}
                      style={{
                        top,
                        height: h,
                        // Columns start on the reading side (right in Arabic).
                        insetInlineStart: `calc(${(col / cols) * 100}% + 2px)`,
                        width: `calc(${100 / cols}% - 4px)`,
                        ...chipColors(a.createdBy.color),
                      }}
                      title={`${time} · ${a.customerName} · ${a.status.name}`}
                    >
                      <span className={cn("block font-semibold leading-tight", cancelled && "line-through")}>{a.customerName}</span>
                      <span className="block tabular-nums leading-tight opacity-90">{time}</span>
                      {h > 52 && <span className="block truncate leading-tight opacity-90">{productLine(a, t)}</span>}
                      {detailed && h > 70 && (
                        <span className="mt-0.5 block truncate leading-tight opacity-90">
                          {a.technicians.map((x) => x.name).join("، ") || t("appointments.unassigned")}
                          {a.area ? ` · ${a.area}` : ""}
                        </span>
                      )}
                      {detailed && h > 88 && <span className="mt-0.5 block truncate leading-tight opacity-90">{a.status.name}</span>}
                    </button>
                  );
                })}
                {d === today && nowMin >= hours.start * 60 && nowMin <= hours.end * 60 && (
                  <div className="pointer-events-none absolute inset-x-0 z-10 flex items-center" style={{ top: ((nowMin - hours.start * 60) / 60) * HOUR_PX }} aria-hidden>
                    <span className="-ms-1 h-2.5 w-2.5 rounded-full bg-brand" />
                    <span className="h-0.5 flex-1 bg-brand" />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
});

const Agenda = memo(function Agenda({
  days,
  today,
  events,
  onSelect,
}: {
  days: string[];
  today: string;
  events: CalEvent[];
  onSelect: (a: AppointmentListItem) => void;
}) {
  const t = useT();
  const groups = useMemo(() => {
    const byStart = new Map<string, CalEvent[]>();
    for (const ev of events) {
      const list = byStart.get(ev.startKey);
      if (list) list.push(ev);
      else byStart.set(ev.startKey, [ev]);
    }
    return days.map((d) => ({ d, list: byStart.get(d) ?? [] })).filter((g) => g.list.length);
  }, [days, events]);
  if (!groups.length) return <p className="px-6 py-14 text-center text-sm text-fg-muted">{t("calendar.empty")}</p>;
  return (
    <div className="divide-y divide-line">
      {groups.map(({ d, list }) => (
        <section key={d} className="px-4 py-3 [contain-intrinsic-size:auto_480px] [content-visibility:auto] sm:px-5">
          <h3 className={cn("mb-2 text-sm font-semibold", d === today ? "text-brand-text" : "text-fg")}>
            {formatKey(d, { weekday: "long", day: "numeric", month: "long" }, t.locale)}
            {d === today && ` · ${t("common.today")}`}
            <span className="ms-2 font-normal text-fg-subtle">{list.length}</span>
          </h3>
          <ul className="space-y-2">
            {list.map(({ a, time }) => (
              <li key={a.id}>
                <button type="button" onClick={() => onSelect(a)} className="flex w-full gap-3 rounded-lg border border-line p-3 text-start hover:bg-surface-muted">
                  <span className="w-1.5 shrink-0 rounded-full" style={{ backgroundColor: colorOrFallback(a.createdBy.color) }} aria-hidden />
                  <bdi className="w-24 shrink-0 text-sm font-semibold tabular-nums">{time}</bdi>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className={cn("font-medium", a.status.kind === "CANCELLED" && "line-through")}>{a.customerName}</span>
                      <StatusBadge name={a.status.name} color={a.status.color} />
                    </span>
                    <span className="mt-0.5 block truncate text-sm text-fg-muted">{productLine(a, t)}</span>
                    <span className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-fg-subtle">
                      {(a.area || a.building) && (
                        <span className="inline-flex items-center gap-1">
                          <MapPin className="h-3 w-3" /> {[a.building, a.area].filter(Boolean).join("، ")}
                        </span>
                      )}
                      <span className="inline-flex items-center gap-1">
                        <Users className="h-3 w-3" /> {a.technicians.map((x) => x.name).join("، ") || t("appointments.unassigned")}
                      </span>
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
});

function DetailsPanel({ a, tz, onClose }: { a: AppointmentListItem; tz: string; onClose: () => void }) {
  const t = useT();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40" role="dialog" aria-modal="true" aria-label={`${t("appointment.title")} ${a.code}`}>
      <button type="button" className="absolute inset-0 bg-black/30" onClick={onClose} aria-label={t("calendar.closeDetails")} />
      <aside className="absolute inset-y-0 end-0 flex w-full max-w-md flex-col border-s border-line bg-surface shadow-pop">
        <div className="h-1.5" style={{ backgroundColor: colorOrFallback(a.createdBy.color) }} aria-hidden />
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div>
            <p className="text-xs font-medium text-fg-subtle" dir="ltr">
              {a.code}
            </p>
            <h2 className="text-lg font-semibold">{a.customerName}</h2>
            <p className="text-sm text-fg-muted">
              {formatKey(dateKey(a.startsAt, tz), { weekday: "long", day: "numeric", month: "long" }, t.locale)} · <bdi className="tabular-nums">{timeRange(a.startsAt, a.endsAt, tz)}</bdi>
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-md p-1 text-fg-subtle hover:bg-surface-muted" aria-label={t("common.close")}>
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge name={a.status.name} color={a.status.color} />
          </div>
          <dl className="space-y-3">
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-fg-subtle">{t("appointment.installation")}</dt>
              <dd className="mt-0.5">{productLine(a, t)}</dd>
            </div>
            {a.customerPhone && (
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-fg-subtle">{t("common.phone")}</dt>
                <dd className="mt-0.5" dir="ltr">
                  {a.customerPhone}
                </dd>
              </div>
            )}
            {(a.area || a.building) && (
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-fg-subtle">{t("appointment.location")}</dt>
                <dd className="mt-0.5">{[a.building, a.area].filter(Boolean).join("، ")}</dd>
              </div>
            )}
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-fg-subtle">{t("common.technicians")}</dt>
              <dd className="mt-0.5">{a.technicians.map((x) => x.name).join("، ") || <span className="text-warning">{t("appointments.noTechnician")}</span>}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-fg-subtle">{t("filters.salesEmployee")}</dt>
              <dd className="mt-1">
                <SalesTag name={a.createdBy.name} color={a.createdBy.color} inactive={!a.createdBy.isActive} />
              </dd>
            </div>
          </dl>
        </div>
        <div className="border-t border-line p-4">
          <Link href={`/appointments/${a.id}`} className={buttonClasses("primary", "md", "w-full")}>
            {t("calendar.openDetails")} <ExternalLink className="h-4 w-4" />
          </Link>
        </div>
      </aside>
    </div>
  );
}
