/**
 * Reads a quotation page from the company website (Aura parseQuote_): the items table (name,
 * quantity, unit price, total, specification, code), the quotation number, totals, and the
 * customer's name and phone and the Sales person. Pure, so it is tested on saved pages.
 */
import type { QuoteDTO } from "./types";

function text(html: string): string {
  return html
    .replace(/<img[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#?\w+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseQuote(html: string, fetchedAt: Date = new Date()): QuoteDTO {
  const items: QuoteDTO["items"] = [];
  type Columns = Partial<Record<"name" | "qty" | "unit" | "total" | "spec" | "desc" | "sku", number>>;
  let map: Columns | null = null;
  for (const row of html.match(/<tr[\s\S]*?<\/tr>/gi) ?? []) {
    const cells = (row.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) ?? []).map(text);
    if (!cells.length) continue;
    const low = cells.map((c) => c.toLowerCase());
    if (!map && low.some((c) => /^qty|الكمية/.test(c))) {
      const m: Columns = {};
      low.forEach((c, i) => {
        if (/name|model|الصنف|المنتج|الاسم/.test(c) && m.name === undefined) m.name = i;
        else if (/^qty|quantity|الكمية/.test(c)) m.qty = i;
        else if (/unit/.test(c) || /سعر الوحدة/.test(c)) m.unit = i;
        else if (/total|الإجمالي/.test(c)) m.total = i;
        else if (/spec|المواصفات/.test(c)) m.spec = i;
        else if (/desc|الوصف/.test(c)) m.desc = i;
        else if (/sku|الكود/.test(c)) m.sku = i;
      });
      map = m;
      continue;
    }
    if (!map || map.name === undefined || map.qty === undefined) continue;
    const name = cells[map.name];
    const qty = cells[map.qty] ?? "";
    if (!name || !/^\d+$/.test(qty)) continue;
    items.push({
      name: name.slice(0, 200),
      qty: Number(qty),
      ...(map.spec !== undefined && cells[map.spec] ? { spec: cells[map.spec]!.slice(0, 200) } : {}),
      ...(map.sku !== undefined && cells[map.sku] ? { sku: cells[map.sku]!.slice(0, 60) } : {}),
      ...(map.unit !== undefined && cells[map.unit] ? { unit: cells[map.unit]!.slice(0, 40) } : {}),
      ...(map.total !== undefined && cells[map.total] ? { total: cells[map.total]!.slice(0, 40) } : {}),
    });
    if (items.length >= 100) break;
  }
  const all = text(html);
  const client =
    all.match(/(?:CLIENT INFORMATION\s*)?Name\s*:\s*([^:]{3,60}?)\s*(?:Phone|Mobile|التليفون)\s*:/i)?.[1] ??
    all.match(/(?:Client|Customer|العميل)\s*(?:Name)?\s*:?\s*([^\d:]{3,60}?)\s*(?:Phone|Mobile|التليفون|01\d)/i)?.[1] ??
    "";
  return {
    number: all.match(/AURA-Q-\d{4}-\d+/)?.[0] ?? "",
    client: client.trim().replace(/^(MRS?|MS|Mr|Mrs|Ms|Eng|Dr)\.?\s+/i, ""),
    phone: all.match(/01\d{9}/)?.[0] ?? "",
    sales: (all.match(/Sales\s*:\s*([^:]{2,40}?)\s*(?:Mobile|Phone|Email)\s*:/i)?.[1] ?? "").trim(),
    items,
    count: items.reduce((n, x) => n + x.qty, 0),
    total: all.match(/(?:Grand Total|الإجمالي الكلي)[^\d]{0,20}([\d,]+\.?\d*)/i)?.[1] ?? "",
    install: all.match(/Installation[^\d]{0,40}?(\d[\d,]*\.?\d*)/i)?.[1] ?? "",
    fetchedAt: fetchedAt.toISOString(),
  };
}

/** Technicians and others who do not see money get the items without prices (Aura noPrices_). */
export function quoteForReader(q: QuoteDTO, seesPrices: boolean): QuoteDTO {
  if (seesPrices) return q;
  return {
    ...q,
    total: undefined,
    install: undefined,
    items: q.items.map((it) => ({ name: it.name, qty: it.qty, ...(it.spec ? { spec: it.spec } : {}), ...(it.sku ? { sku: it.sku } : {}) })),
  };
}
