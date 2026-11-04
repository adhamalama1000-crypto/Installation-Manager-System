"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, X } from "lucide-react";
import { useT } from "@/i18n/client";
import { cn } from "@/lib/utils";

export type ComboOption = { id: string; label: string; hint?: string; disabled?: boolean; keywords?: string };

/** Lower-case, without Arabic diacritics / tatweel, alef and yaa forms unified, for matching. */
export function foldText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[ً-ْـ]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .trim();
}

/** Options whose label, hint or keywords contain every word of the query (any order). */
export function filterOptions<O extends ComboOption>(options: O[], query: string, limit = 50): O[] {
  const words = foldText(query).split(/\s+/).filter(Boolean);
  if (!words.length) return options.slice(0, limit);
  const out: O[] = [];
  for (const o of options) {
    const hay = foldText(`${o.label} ${o.hint ?? ""} ${o.keywords ?? ""}`);
    if (words.every((w) => hay.includes(w))) out.push(o);
    if (out.length >= limit) break;
  }
  return out;
}

type Props = {
  /** Accessible name; also the visible label when `showLabel`. */
  label: string;
  value: string | null;
  onChange: (id: string | null) => void;
  /** Static options (filtered locally), or omit and give `load` for a server search. */
  options?: ComboOption[];
  /** Server search; called (debounced) with the typed text. */
  load?: (query: string, signal: AbortSignal) => Promise<ComboOption[]>;
  /** The label of the chosen value when it is not in `options` (server search). */
  selectedLabel?: string | null;
  placeholder?: string;
  /** Adds a "none" row that clears the choice. */
  allowClear?: boolean;
  clearLabel?: string;
  disabled?: boolean;
  id?: string;
  invalid?: boolean;
  describedBy?: string;
  className?: string;
  /** Minimum characters before a server search starts. */
  minChars?: number;
};

/**
 * A select box you can type into: the list narrows as you type (Arabic letters folded, words in
 * any order), arrow keys move, Enter picks, Escape closes, Home / End jump. It follows the WAI-ARIA
 * combobox pattern (role="combobox" with aria-activedescendant on a listbox), works with static
 * options or a debounced server search, and keeps the focus in the text box while the list is used.
 */
export function Combobox({
  label,
  value,
  onChange,
  options,
  load,
  selectedLabel,
  placeholder,
  allowClear,
  clearLabel,
  disabled,
  id: idProp,
  invalid,
  describedBy,
  className,
  minChars = 1,
}: Props) {
  const t = useT();
  const autoId = useId();
  const id = idProp ?? autoId;
  const listId = `${id}-list`;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [remote, setRemote] = useState<{ q: string; rows: ComboOption[] } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const current = options?.find((o) => o.id === value) ?? null;
  const currentLabel = current?.label ?? selectedLabel ?? "";

  useEffect(() => {
    if (!load || !open) return;
    const q = query.trim();
    if (q.length < minChars) return;
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      load(q, ctl.signal)
        .then((rows) => setRemote({ q, rows }))
        .catch(() => {
          if (!ctl.signal.aborted) setRemote({ q, rows: [] });
        });
    }, 220);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [load, open, query, minChars]);

  const rows = useMemo<ComboOption[]>(() => {
    const base = load ? (remote && remote.q === query.trim() ? remote.rows : []) : filterOptions(options ?? [], query);
    return allowClear ? [{ id: "", label: clearLabel ?? t("common.none") }, ...base] : base;
  }, [load, remote, query, options, allowClear, clearLabel, t]);
  const loading = !!load && open && query.trim().length >= minChars && remote?.q !== query.trim();

  function choose(o: ComboOption | undefined) {
    if (!o || o.disabled) return;
    onChange(o.id === "" ? null : o.id);
    setOpen(false);
    setQuery("");
  }

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    const last = rows.length - 1;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) setOpen(true);
      else setActive((a) => Math.min(last, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Home" && open) {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End" && open) {
      e.preventDefault();
      setActive(Math.max(0, last));
    } else if (e.key === "Enter") {
      if (open && rows.length) {
        e.preventDefault();
        choose(rows[active]);
      }
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      setOpen(false);
      setQuery("");
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  }

  return (
    <div
      className={cn("relative", className)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setOpen(false);
          setQuery("");
        }
      }}
    >
      <input
        ref={inputRef}
        id={id}
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && rows[active] ? `${id}-opt-${active}` : undefined}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        disabled={disabled}
        autoComplete="off"
        dir="auto"
        value={open ? query : currentLabel}
        placeholder={open ? currentLabel || placeholder : placeholder}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => {
          setActive(0);
          setOpen(true);
        }}
        onClick={() => setOpen(true)}
        onKeyDown={onKeyDown}
        className={cn(
          "h-10 w-full rounded-lg border border-line-strong bg-surface ps-3 pe-9 text-sm text-fg shadow-card placeholder:text-fg-subtle transition-colors",
          "focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25 disabled:cursor-not-allowed disabled:opacity-60",
          invalid && "border-danger ring-danger/20",
        )}
      />
      {value && allowClear && !disabled ? (
        <button
          type="button"
          tabIndex={-1}
          aria-label={clearLabel ?? t("common.none")}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onChange(null)}
          className="absolute inset-y-0 end-0 flex w-9 items-center justify-center text-fg-subtle hover:text-fg"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      ) : (
        <ChevronDown className="pointer-events-none absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
      )}
      {open && (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={label}
          className="absolute inset-x-0 top-full z-30 mt-1 max-h-64 overflow-y-auto rounded-lg border border-line bg-surface py-1 shadow-pop"
        >
          {loading ? (
            <li className="px-3 py-2 text-sm text-fg-muted" role="status">
              {t("common.loading")}
            </li>
          ) : !rows.length ? (
            <li className="px-3 py-2 text-sm text-fg-muted">{load && query.trim().length < minChars ? t("forms.typeToSearch") : t("forms.noMatches")}</li>
          ) : (
            rows.map((o, i) => (
              <li
                key={o.id || "__none"}
                id={`${id}-opt-${i}`}
                data-index={i}
                role="option"
                aria-selected={o.id === (value ?? "")}
                aria-disabled={o.disabled || undefined}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(o)}
                className={cn(
                  "flex cursor-pointer items-center gap-2 px-3 py-2 text-sm",
                  i === active ? "bg-brand-soft text-brand-text" : "text-fg",
                  o.disabled && "cursor-not-allowed opacity-50",
                )}
              >
                <Check className={cn("h-3.5 w-3.5 shrink-0", o.id === (value ?? "") ? "opacity-100" : "opacity-0")} aria-hidden />
                <span className="min-w-0 flex-1 truncate" dir="auto">
                  {o.label}
                </span>
                {o.hint && (
                  <span className="shrink-0 text-xs text-fg-subtle" dir="auto">
                    {o.hint}
                  </span>
                )}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
