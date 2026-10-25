import { FALLBACK_USER_COLOR } from "./constants";

export const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

function channel(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number {
  const h = HEX_COLOR_RE.test(hex) ? hex : FALLBACK_USER_COLOR;
  const r = parseInt(h.slice(1, 3), 16);
  const g = parseInt(h.slice(3, 5), 16);
  const b = parseInt(h.slice(5, 7), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Picks white or near-black text, whichever is more readable on the given background. */
export function readableTextColor(bg: string): "#FFFFFF" | "#111111" {
  return contrastRatio(bg, "#FFFFFF") >= contrastRatio(bg, "#111111") ? "#FFFFFF" : "#111111";
}

export function colorOrFallback(color: string | null | undefined): string {
  return color && HEX_COLOR_RE.test(color) ? color : FALLBACK_USER_COLOR;
}

/** Background + text pair for an event chip coloured by the Sales creator. */
export function chipColors(color: string | null | undefined) {
  const bg = colorOrFallback(color);
  return { backgroundColor: bg, color: readableTextColor(bg) };
}
