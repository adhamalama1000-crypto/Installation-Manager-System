import { describe, expect, it } from "vitest";
import { localeFromAcceptLanguage } from "@/i18n/config";
import type { Entry } from "@/i18n/define";
import { createFormatter } from "@/i18n/format";
import { messages } from "@/i18n/messages";
import { decodeMessage, msg, ref, translate, translateMessage } from "@/i18n/translate";

const placeholders = (text: string) => new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!));
const forms = (e: Entry) => (typeof e === "string" ? [e] : Object.values(e).filter((v): v is string => typeof v === "string"));
const other = (e: Entry) => (typeof e === "string" ? e : e.other);

/** Entries that are the same in both languages on purpose (brand names, examples, symbols). */
const SAME_IN_BOTH = new Set(["auth.emailPlaceholder", "common.dash"]);

describe("translation completeness", () => {
  const entries = Object.entries(messages);

  it("has an English and an Arabic text for every key, none empty", () => {
    for (const [key, pair] of entries) {
      for (const lang of ["en", "ar"] as const) {
        for (const text of forms(pair[lang])) expect(text.trim(), `${key} (${lang})`).not.toBe("");
      }
    }
  });

  it("uses the same placeholders in both languages", () => {
    for (const [key, pair] of entries) {
      expect([...placeholders(other(pair.ar))].sort(), key).toEqual([...placeholders(other(pair.en))].sort());
      // Every Arabic plural form may only use placeholders English has (one/two forms may spell the number out).
      const en = new Set(forms(pair.en).flatMap((f) => [...placeholders(f)]));
      for (const f of forms(pair.ar)) for (const p of placeholders(f)) expect(en.has(p), `${key}: {${p}}`).toBe(true);
    }
  });

  it("gives plural entries every form each language needs", () => {
    for (const [key, pair] of entries) {
      if (typeof pair.en !== "string") expect(pair.en.one && pair.en.other, key).toBeTruthy();
      if (typeof pair.ar !== "string") {
        for (const form of ["one", "two", "few", "many", "other"] as const) expect(pair.ar[form], `${key}.${form}`).toBeTruthy();
      }
      expect(typeof pair.en === "string", `${key}: plural in one language only`).toBe(typeof pair.ar === "string");
    }
  });

  it("has an actual Arabic translation (not a copy of the English)", () => {
    for (const [key, pair] of entries) {
      if (SAME_IN_BOTH.has(key)) continue;
      const ar = other(pair.ar);
      expect(/[؀-ۿ]/.test(ar) || /^[\p{P}\p{S}\s\d{}\w-]*$/u.test(ar) === false, `${key} looks untranslated: ${ar}`).toBe(true);
    }
  });
});

describe("translate", () => {
  it("interpolates parameters and picks plural forms per language", () => {
    expect(translate("en", "common.results", { count: 0 })).toBe("No results");
    expect(translate("en", "common.results", { count: 1 })).toBe("1 result");
    expect(translate("en", "common.results", { count: 12 })).toBe("12 results");
    expect(translate("ar", "common.results", { count: 2 })).toBe("نتيجتان");
    expect(translate("ar", "common.results", { count: 5 })).toBe("5 نتائج");
    expect(translate("ar", "common.results", { count: 11 })).toBe("11 نتيجة");
    expect(translate("ar", "common.pageOf", { page: 2, pages: 7 })).toBe("صفحة 2 من 7");
  });

  it("encodes server messages as descriptors and translates them for each reader", () => {
    const text = msg("e.technicianInactive", { name: "Karim" });
    expect(decodeMessage(text)).toEqual({ key: "e.technicianInactive", params: { name: "Karim" } });
    expect(translateMessage(text, "en")).toBe("Karim is inactive and cannot be assigned.");
    expect(translateMessage(text, "ar")).toBe("Karim غير نشط ولا يمكن تكليفه.");
  });

  it("translates nested messages, money and dates inside parameters", () => {
    const text = msg("e.onLeaveOne", { name: "Karim", type: ref("enum.leaveType.SICK"), range: { day: "2026-03-14" } });
    expect(translateMessage(text, "en")).toBe("Karim is on Sick leave (Sat 14 Mar)");
    expect(translateMessage(text, "ar")).toContain("إجازة مرضية");
    expect(translateMessage(msg("e.collectedOverDue", { amount: { money: 1500 } }), "ar")).toBe("هذا أكثر من المبلغ المستحق (1,500 ج.م).");
  });

  it("passes plain text (user data, older stored messages) through unchanged", () => {
    expect(translateMessage("Old English notification", "ar")).toBe("Old English notification");
    expect(translateMessage("@@not.a.key", "ar")).toBe("@@not.a.key");
    expect(translateMessage(null, "ar")).toBe("");
  });
});

describe("formatting", () => {
  it("formats dates in the company timezone with Arabic month names and Latin digits", () => {
    const ar = createFormatter("ar", "Africa/Cairo");
    const en = createFormatter("en", "Africa/Cairo");
    const instant = "2026-03-14T08:30:00.000Z"; // 10:30 in Cairo
    expect(en.time(instant)).toBe("10:30");
    expect(ar.time(instant)).toBe("10:30");
    expect(en.date(instant)).toBe("Sat 14 Mar 2026");
    expect(ar.date(instant)).toMatch(/مارس/);
    expect(ar.date(instant)).toMatch(/14/);
    expect(ar.date(instant)).not.toMatch(/[٠-٩]/);
  });

  it("formats money and numbers per language", () => {
    expect(createFormatter("en", "UTC").money(2500)).toBe("2,500 EGP");
    expect(createFormatter("ar", "UTC").money(2500.5)).toBe("2,500.50 ج.م");
    expect(createFormatter("en", "UTC").money(null)).toBe("—");
  });

  it("names weekdays and calendar days without shifting them", () => {
    expect(createFormatter("en", "Pacific/Kiritimati").day("2026-03-14")).toBe("Sat 14 Mar");
    expect(createFormatter("ar", "UTC").weekday(5)).toBe("الجمعة");
    expect(createFormatter("en", "UTC").weekday(0)).toBe("Sunday");
  });
});

describe("locale negotiation", () => {
  it("picks the first supported language from Accept-Language", () => {
    expect(localeFromAcceptLanguage("en-US,en;q=0.9")).toBe("en");
    expect(localeFromAcceptLanguage("fr-FR,ar;q=0.8,en;q=0.5")).toBe("ar");
    expect(localeFromAcceptLanguage("fr-FR")).toBeNull();
    expect(localeFromAcceptLanguage(null)).toBeNull();
  });
});
