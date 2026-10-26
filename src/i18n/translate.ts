/**
 * Translation and message descriptors.
 *
 * Code that runs on the server (validation, services) cannot know the reader's language when it
 * builds a message - a notification is read later, by someone else. It therefore produces a
 * *descriptor*: a message key plus parameters, encoded as a string by `msg()`. Whoever displays
 * it calls `translateMessage()` with the reader's locale. Plain strings (user data, older stored
 * text) pass through unchanged.
 */
import type { Locale } from "./config";
import type { Entry } from "./define";
import { createFormatter } from "./format";
import { messages, type MessageKey } from "./messages";

/** A parameter: plain text/number, a nested message, a date in a timezone, a calendar day or money. */
export type Param =
  | string
  | number
  | null
  | undefined
  | { k: MessageKey; p?: Params }
  | { d: string; tz: string; s: "date" | "time" | "dateTime" | "when" | "longDate" | "shortDate"; e?: string }
  | { day: string; to?: string }
  | { money: number }
  | { list: Param[] };
export type Params = Record<string, Param>;

const PREFIX = "@@";

export function isMessageKey(key: string): key is MessageKey {
  return Object.prototype.hasOwnProperty.call(messages, key);
}

/** Encodes a message descriptor as a string (safe to store, send as JSON or throw). */
export function msg(key: MessageKey, params?: Params): string {
  return params && Object.keys(params).length ? `${PREFIX}${key}|${JSON.stringify(params)}` : `${PREFIX}${key}`;
}

/** A nested, translatable parameter value. */
export function ref(key: MessageKey, params?: Params): Param {
  return params ? { k: key, p: params } : { k: key };
}

export function decodeMessage(text: string): { key: MessageKey; params?: Params } | null {
  if (!text.startsWith(PREFIX)) return null;
  const bar = text.indexOf("|");
  const key = bar === -1 ? text.slice(PREFIX.length) : text.slice(PREFIX.length, bar);
  if (!isMessageKey(key)) return null;
  if (bar === -1) return { key };
  try {
    return { key, params: JSON.parse(text.slice(bar + 1)) as Params };
  } catch {
    return { key };
  }
}

const pluralRules = new Map<Locale, Intl.PluralRules>();

function pickEntry(entry: Entry, locale: Locale, count: unknown): string {
  if (typeof entry === "string") return entry;
  if (typeof count !== "number") return entry.other;
  let rules = pluralRules.get(locale);
  if (!rules) {
    rules = new Intl.PluralRules(locale);
    pluralRules.set(locale, rules);
  }
  // Exact zero gets its own wording in both languages when one is given ("No items").
  if (count === 0 && entry.zero) return entry.zero;
  return entry[rules.select(count) as keyof typeof entry] ?? entry.other;
}

function renderParam(value: Param, locale: Locale, tz: string): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return createFormatter(locale, tz).number(value);
  if (typeof value === "string") return translateMessage(value, locale, tz);
  if ("k" in value) return translate(locale, value.k, value.p, tz);
  if ("d" in value) {
    const f = createFormatter(locale, value.tz);
    if (value.s === "when") return f.when(value.d, value.e ?? value.d);
    return f[value.s](value.d);
  }
  if ("day" in value) {
    const f = createFormatter(locale, "UTC");
    return value.to ? f.dayRange(value.day, value.to) : f.day(value.day);
  }
  if ("money" in value) return createFormatter(locale, tz).money(value.money);
  if ("list" in value) return createFormatter(locale, tz).list(value.list.map((v) => renderParam(v, locale, tz)).filter(Boolean));
  return "";
}

/** Translates a key. `{name}` placeholders are replaced by the parameters. */
export function translate(locale: Locale, key: MessageKey, params?: Params, tz = "UTC"): string {
  const pair = messages[key];
  if (!pair) return key;
  const text = pickEntry(pair[locale], locale, params?.count);
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? renderParam(params[name], locale, tz) : whole));
}

/** Translates a descriptor produced by `msg()`; any other text is returned unchanged. */
export function translateMessage(text: string | null | undefined, locale: Locale, tz = "UTC"): string {
  if (!text) return "";
  const d = decodeMessage(text);
  return d ? translate(locale, d.key, d.params, tz) : text;
}

/** Translates every value of a field-error map. */
export function translateFieldErrors(errors: Record<string, string>, locale: Locale, tz = "UTC"): Record<string, string> {
  return Object.fromEntries(Object.entries(errors).map(([k, v]) => [k, translateMessage(v, locale, tz)]));
}

export type { MessageKey };
