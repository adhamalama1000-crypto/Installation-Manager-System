/**
 * Rough centres of Cairo areas (Aura AREA_GEO), with English spellings, used when a site has no
 * map pin: for the estimated arrival, the car's route order and its warnings, and the technician
 * suggestion. Never shown as a location and never used for "far from the customer" flags.
 */
import type { Geo } from "./field";

const AREAS: { ar: string; en: string[]; at: [number, number] }[] = [
  { ar: "التجمع الخامس", en: ["fifth settlement", "5th settlement", "new cairo"], at: [30.008, 31.47] },
  { ar: "التجمع الأول", en: ["first settlement", "1st settlement"], at: [30.064, 31.456] },
  { ar: "التجمع الثالث", en: ["third settlement", "3rd settlement"], at: [30.01, 31.44] },
  { ar: "التجمع", en: ["tagamoa", "settlement"], at: [30.01, 31.46] },
  { ar: "مدينتي", en: ["madinaty"], at: [30.105, 31.64] },
  { ar: "الرحاب", en: ["rehab", "al rehab"], at: [30.06, 31.49] },
  { ar: "الشروق", en: ["shorouk", "el shorouk"], at: [30.14, 31.62] },
  { ar: "العبور", en: ["obour", "el obour"], at: [30.22, 31.47] },
  { ar: "بدر", en: ["badr"], at: [30.14, 31.72] },
  { ar: "العاصمة الإدارية", en: ["new capital", "administrative capital"], at: [30.02, 31.75] },
  { ar: "مدينة نصر", en: ["nasr city"], at: [30.06, 31.34] },
  { ar: "مصر الجديدة", en: ["heliopolis", "masr el gedida"], at: [30.09, 31.33] },
  { ar: "المعادي", en: ["maadi"], at: [29.96, 31.26] },
  { ar: "المقطم", en: ["mokattam"], at: [30.01, 31.3] },
  { ar: "وسط البلد", en: ["downtown"], at: [30.045, 31.24] },
  { ar: "الزمالك", en: ["zamalek"], at: [30.06, 31.22] },
  { ar: "المنيل", en: ["manial"], at: [30.02, 31.225] },
  { ar: "الدقي", en: ["dokki"], at: [30.04, 31.21] },
  { ar: "المهندسين", en: ["mohandessin", "mohandeseen"], at: [30.055, 31.2] },
  { ar: "العجوزة", en: ["agouza"], at: [30.06, 31.21] },
  { ar: "الهرم", en: ["haram", "giza pyramids"], at: [29.99, 31.15] },
  { ar: "الشيخ زايد", en: ["sheikh zayed", "zayed"], at: [30.04, 30.98] },
  { ar: "حدائق أكتوبر", en: ["october gardens", "hadayek october"], at: [29.9, 30.95] },
  { ar: "6 أكتوبر", en: ["6th of october", "6 october", "october"], at: [29.96, 30.93] },
  { ar: "ميفيدا", en: ["mivida"], at: [30.0, 31.5] },
  { ar: "هايد بارك", en: ["hyde park"], at: [30.0, 31.46] },
  { ar: "المستقبل", en: ["mostakbal", "future city"], at: [30.12, 31.57] },
  { ar: "عين شمس", en: ["ain shams"], at: [30.13, 31.33] },
  { ar: "شبرا", en: ["shubra", "shoubra"], at: [30.08, 31.24] },
  { ar: "حلوان", en: ["helwan"], at: [29.85, 31.33] },
];

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/[^\p{L}\p{N} ]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

/** The centre of a known area named in the text (the most specific match wins), or null. */
export function areaGeo(area: string | null | undefined): Geo | null {
  if (!area) return null;
  const text = ` ${norm(area)} `;
  let best: { len: number; at: [number, number] } | null = null;
  for (const a of AREAS) {
    for (const name of [a.ar, ...a.en]) {
      const n = norm(name);
      if (text.includes(` ${n} `) && (!best || n.length > best.len)) best = { len: n.length, at: a.at };
    }
  }
  return best ? { lat: best.at[0], lng: best.at[1] } : null;
}

/** Area names for the booking form's suggestions, in the reader's language. */
export function areaNames(locale: "ar" | "en"): string[] {
  return AREAS.map((a) => (locale === "ar" ? a.ar : a.en[0]!.replace(/\b\w/g, (c) => c.toUpperCase())));
}
