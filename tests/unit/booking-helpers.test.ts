import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { areaGeo } from "@/lib/areas";
import { parseQuote, quoteForReader } from "@/lib/quote";

const html = readFileSync(path.join(__dirname, "../fixtures/quote.html"), "utf8");

describe("quotation parsing (Aura parseQuote_)", () => {
  it("reads the items table, the number, totals, customer and Sales person", () => {
    const q = parseQuote(html, new Date("2026-11-01T10:00:00Z"));
    expect(q).toMatchObject({ number: "AURA-Q-2610-0042", client: "Hossam Fouad", phone: "01001234567", sales: "Sara Mahmoud", count: 3, total: "20,150", install: "750" });
    expect(q.items).toEqual([
      { name: "Philips 9300 Smart Lock", qty: 2, spec: "Face ID", sku: "PH-9300", unit: "8,500", total: "17,000" },
      { name: "Zigbee Hub & Bridge", qty: 1, sku: "HUB-Z", unit: "2,400", total: "2,400" },
    ]);
  });

  it("reads Arabic column headers and ignores pages without a quotation table", () => {
    const ar = parseQuote("<table><tr><td>الصنف</td><td>الكمية</td><td>الإجمالي</td></tr><tr><td>قفل ذكي</td><td>3</td><td>9,000</td></tr></table>");
    expect(ar.items).toEqual([{ name: "قفل ذكي", qty: 3, total: "9,000" }]);
    expect(parseQuote("<p>hello</p>").items).toEqual([]);
  });

  it("hides prices from readers who do not see money", () => {
    const q = quoteForReader(parseQuote(html), false);
    expect(q.total).toBeUndefined();
    expect(q.install).toBeUndefined();
    expect(q.items[0]).toEqual({ name: "Philips 9300 Smart Lock", qty: 2, spec: "Face ID", sku: "PH-9300" });
  });
});

describe("area centres (Aura AREA_GEO)", () => {
  it("finds Cairo areas in Arabic or English, preferring the most specific name", () => {
    expect(areaGeo("مدينة نصر - الحي العاشر")).toEqual({ lat: 30.06, lng: 31.34 });
    expect(areaGeo("Heliopolis")).toEqual({ lat: 30.09, lng: 31.33 });
    expect(areaGeo("التجمع الخامس")).toEqual({ lat: 30.008, lng: 31.47 });
    expect(areaGeo("Fifth Settlement, Cairo")).toEqual({ lat: 30.008, lng: 31.47 });
    expect(areaGeo("مصر الجديده")).toEqual({ lat: 30.09, lng: 31.33 });
    expect(areaGeo("Alexandria")).toBeNull();
    expect(areaGeo(null)).toBeNull();
  });
});
