/**
 * Product identification rules, shared by the server and the browser (pure, no database).
 *
 * - SKU: identifies a product model, never a physical unit. Generated as PREFIX-NNNNN, where the
 *   prefix is the category's code (or its parent's, or PRD) and the number comes from an atomic
 *   database counter per prefix (see services/product-codes.ts).
 * - Variant code: the parent's SKU and a suffix from the variant's English name (SL-00012-BLACK),
 *   or V1, V2... when the name gives nothing usable or the code is taken.
 * - Internal barcode: EAN-13 in the "in-store" range 2xxxxxxxxxxxC (GS1 reserves prefixes 20-29
 *   for numbers a company assigns itself), with a correct check digit, so any scanner reads it.
 */

export const DEFAULT_SKU_PREFIX = "PRD";
export const SKU_DIGITS = 5;
export const SKU_MAX = 64;

/** A category code as typed: capitals, letters and digits, 2-6 characters, starting with a letter. */
export const CATEGORY_CODE_RE = /^[A-Z][A-Z0-9]{1,5}$/;

export function normalizeCategoryCode(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  const v = raw.replace(/\s+/g, "").toUpperCase();
  return v === "" ? null : v;
}

export function formatSku(prefix: string, n: number): string {
  return `${prefix}-${String(n).padStart(SKU_DIGITS, "0")}`;
}

/** Capital letters and digits of an English name, at most `max` characters ("Rose gold" -> "ROSEGOLD"). */
export function codeFromName(name: string | null | undefined, max = 8): string {
  return (name ?? "")
    .normalize("NFKD")
    .replace(/[^\p{ASCII}]/gu, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, max);
}

/**
 * Candidate codes for a variant, best first: PARENT-NAME, then PARENT-V1, PARENT-V2, ...
 * (the caller takes the first one that is free). Always within the SKU length limit.
 */
export function variantCodeCandidates(parentSku: string, variantNameEn: string | null | undefined, count = 50): string[] {
  const out: string[] = [];
  const fromName = codeFromName(variantNameEn);
  const fit = (suffix: string) => `${parentSku.slice(0, SKU_MAX - suffix.length - 1)}-${suffix}`;
  if (fromName) out.push(fit(fromName));
  for (let i = 1; out.length < count; i++) out.push(fit(`V${i}`));
  return out;
}

/** EAN-13 check digit of the first 12 digits. */
export function ean13CheckDigit(first12: string): number {
  if (!/^\d{12}$/.test(first12)) throw new Error("EAN-13 needs 12 digits before the check digit");
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(first12[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10;
}

export function isValidEan13(code: string): boolean {
  return /^\d{13}$/.test(code) && ean13CheckDigit(code.slice(0, 12)) === Number(code[12]);
}

/** The internal barcode for counter value n: "2" + 11 digits + check digit. */
export function internalEan13(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > 99_999_999_999) throw new Error("barcode counter out of range");
  const first12 = `2${String(n).padStart(11, "0")}`;
  return `${first12}${ean13CheckDigit(first12)}`;
}

const L = ["0001101", "0011001", "0010011", "0111101", "0100011", "0110001", "0101111", "0111011", "0110111", "0001011"];
const G = ["0100111", "0110011", "0011011", "0100001", "0011101", "0111001", "0000101", "0010001", "0001001", "0010111"];
const R = ["1110010", "1100110", "1101100", "1000010", "1011100", "1001110", "1010000", "1000100", "1001000", "1110100"];
const PARITY = ["LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG", "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL"];

/** The 95 modules of an EAN-13 symbol ("1" = bar), for drawing it (labels, product page). */
export function ean13Modules(code: string): string {
  if (!isValidEan13(code)) throw new Error("not a valid EAN-13");
  const d = code.split("").map(Number);
  const parity = PARITY[d[0]!]!;
  let bits = "101";
  for (let i = 1; i <= 6; i++) bits += (parity[i - 1] === "L" ? L : G)[d[i]!];
  bits += "01010";
  for (let i = 7; i <= 12; i++) bits += R[d[i]!];
  return bits + "101";
}
