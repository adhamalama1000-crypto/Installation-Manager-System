import { describe, expect, it } from "vitest";
import { codeFromName, ean13CheckDigit, ean13Modules, formatSku, internalEan13, isValidEan13, normalizeCategoryCode, variantCodeCandidates } from "@/lib/product-codes";
import { SKU_RE } from "@/lib/inventory";

describe("automatic product codes", () => {
  it("formats SKUs from a prefix and a counter", () => {
    expect(formatSku("LCK", 1)).toBe("LCK-00001");
    expect(formatSku("PRD", 123456)).toBe("PRD-123456");
    expect(SKU_RE.test(formatSku("CAM", 42))).toBe(true);
  });

  it("normalises category codes", () => {
    expect(normalizeCategoryCode(" lck ")).toBe("LCK");
    expect(normalizeCategoryCode("")).toBeNull();
  });

  it("derives variant suffixes from the English name, then numbers", () => {
    expect(codeFromName("Black")).toBe("BLACK");
    expect(codeFromName("Rose gold matte")).toBe("ROSEGOLD");
    expect(codeFromName("Crème")).toBe("CREME");
    expect(codeFromName("أسود")).toBe("");
    expect(variantCodeCandidates("SL-00012", "Black").slice(0, 3)).toEqual(["SL-00012-BLACK", "SL-00012-V1", "SL-00012-V2"]);
    expect(variantCodeCandidates("SL-00012", "أسود")[0]).toBe("SL-00012-V1");
    const long = "X".repeat(64);
    for (const c of variantCodeCandidates(long, "Silver", 5)) {
      expect(c.length).toBeLessThanOrEqual(64);
      expect(SKU_RE.test(c)).toBe(true);
    }
  });

  it("computes EAN-13 check digits (known codes)", () => {
    expect(ean13CheckDigit("400638133393")).toBe(1); // 4006381333931
    expect(ean13CheckDigit("590123412345")).toBe(7); // 5901234123457
    expect(isValidEan13("4006381333931")).toBe(true);
    expect(isValidEan13("4006381333932")).toBe(false);
  });

  it("issues internal barcodes in the in-store range with a valid check digit", () => {
    const code = internalEan13(1);
    expect(code).toMatch(/^2\d{12}$/);
    expect(code.slice(0, 12)).toBe("200000000001");
    expect(isValidEan13(code)).toBe(true);
    expect(() => internalEan13(0)).toThrow();
  });

  it("encodes the 95 modules of an EAN-13 symbol", () => {
    const m = ean13Modules("4006381333931");
    expect(m).toHaveLength(95);
    expect(m.startsWith("101")).toBe(true);
    expect(m.slice(45, 50)).toBe("01010");
    expect(m.endsWith("101")).toBe(true);
  });
});
