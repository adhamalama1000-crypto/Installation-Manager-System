/** Text matching shared by pickers, imports and searches (pure; usable on the server and in the browser). */

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
