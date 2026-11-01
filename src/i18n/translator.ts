/**
 * Translation function shared by the server and the browser.
 *
 *   t("appointments.title")                       -> "المواعيد" / "Appointments"
 *   t("common.visits", { count: 3 })              -> plural form chosen with Intl.PluralRules
 *   t("leave.onLeave", { name: "Karim" })         -> "{name}" placeholders are filled in
 *   { method: "@enums.paymentMethod.CASH" }      -> a parameter starting with "@" is a message itself
 *   { status: "Done", statusAr: "تم" }           -> Arabic readers get the "<name>Ar" variant when given
 *
 * Messages that must travel as plain strings (Zod issues, field errors from the server) are
 * encoded with `msg("validation.required", { field: "@fields.customerName" })` and turned into text
 * with `t.msg(...)`; parameters starting with "@" are message keys themselves.
 */
import { intlLocale, type Locale } from "./config";
import { ar } from "./messages/ar";
import { en, type Messages } from "./messages/en";
import type { Plural } from "./types";

type Leaf = string | Plural;

type Keys<T, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends Leaf ? `${P}${K}` : Keys<T[K], `${P}${K}.`>;
}[keyof T & string];

export type MessageKey = Keys<Messages>;
export type TParams = Record<string, string | number | null | undefined>;

export type T = {
  (key: MessageKey, params?: TParams): string;
  /** Translates an encoded message (see `msg`); returns other text unchanged. */
  msg: (text: string | null | undefined) => string;
  /** Translates a key known only at runtime (e.g. built from an enum value); falls back to `fallback`. */
  dyn: (key: string, params?: TParams, fallback?: string) => string;
  locale: Locale;
};

const DICTS: Record<Locale, Messages> = { ar, en };
const PLURAL_KEYS = new Set(["zero", "one", "two", "few", "many", "other"]);

function isPlural(v: unknown): v is Plural {
  return !!v && typeof v === "object" && "other" in v && Object.keys(v).every((k) => PLURAL_KEYS.has(k));
}

function lookup(dict: unknown, key: string): Leaf | undefined {
  let cur: unknown = dict;
  for (const part of key.split(".")) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === "string" || isPlural(cur) ? cur : undefined;
}

/** Encodes a translatable message so it can be passed around as a plain string. */
export function msg(key: MessageKey, params?: TParams): string {
  return params ? `${key}|${JSON.stringify(params)}` : key;
}

const cache = new Map<Locale, T>();

export function createT(locale: Locale): T {
  const hit = cache.get(locale);
  if (hit) return hit;
  const dict = DICTS[locale];
  const rules = new Intl.PluralRules(intlLocale(locale));
  const numbers = new Intl.NumberFormat(intlLocale(locale));

  const render = (leaf: Leaf, params?: TParams): string => {
    let text: string;
    if (typeof leaf === "string") text = leaf;
    else {
      const count = Number(params?.count ?? 0);
      const form = count === 0 && leaf.zero !== undefined ? "zero" : rules.select(count);
      text = leaf[form as keyof Plural] ?? leaf.other;
    }
    if (!params) return text;
    return text.replace(/\{(\w+)\}/g, (whole, name: string) => {
      // Admin-entered names travel with their Arabic version as "<name>Ar" (e.g. status / statusAr).
      const arabic = locale === "ar" ? params[`${name}Ar`] : undefined;
      const v = arabic !== undefined && arabic !== null && arabic !== "" ? arabic : params[name];
      if (v === undefined || v === null) return whole;
      if (typeof v === "number") return numbers.format(v);
      // "@key" (or an encoded "@key|{...}") is itself a message.
      if (!v.startsWith("@")) return v;
      const inner = t.msg(v.slice(1));
      return inner === v.slice(1) ? v : inner;
    });
  };

  const translate = (key: string, params?: TParams, fallback?: string): string => {
    const leaf = lookup(dict, key) ?? lookup(en, key);
    if (leaf === undefined) return fallback ?? key;
    return render(leaf, params);
  };

  const t = ((key: MessageKey, params?: TParams) => translate(key, params)) as T;
  t.dyn = (key, params, fallback) => translate(key, params, fallback);
  t.locale = locale;
  t.msg = (text) => {
    if (!text) return "";
    // Several messages joined with newlines (encoded messages never contain a raw newline).
    if (text.includes("\n")) return text.split("\n").map(t.msg).join("\n");
    const bar = text.indexOf("|");
    const key = bar === -1 ? text : text.slice(0, bar);
    if (!/^[a-z][\w]*(\.\w+)+$/.test(key) || lookup(en, key) === undefined) return text;
    let params: TParams | undefined;
    if (bar !== -1) {
      try {
        params = JSON.parse(text.slice(bar + 1)) as TParams;
      } catch {
        return text;
      }
    }
    return translate(key, params);
  };
  cache.set(locale, t);
  return t;
}
