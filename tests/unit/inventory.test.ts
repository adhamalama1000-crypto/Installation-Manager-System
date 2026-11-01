import { describe, expect, it } from "vitest";
import {
  docPermissions,
  docWarehouseSides,
  formatDocNumber,
  formatQuantity,
  lineTakesCost,
  normalizeCode,
  productSchema,
  stockDocSchema,
  warehouseSchema,
} from "@/lib/inventory";
import { canSeeCosts, permissionsFor } from "@/lib/permissions";
import { createT } from "@/i18n/translator";
import { fieldErrorsFromZod } from "@/lib/validation";

const settings = { salesCanViewReports: true, technicianCanSeeContacts: true };
const en = createT("en");
const ar = createT("ar");
const errors = (schema: { safeParse: (v: unknown) => { success: boolean; error?: unknown } }, v: unknown) => {
  const r = schema.safeParse(v);
  return r.success ? {} : fieldErrorsFromZod(r.error as Parameters<typeof fieldErrorsFromZod>[0]);
};

describe("document rules", () => {
  it("names who prepares and who posts each document type", () => {
    expect(docPermissions("RECEIPT", null)).toEqual({ prepare: "inventory.receive", post: "inventory.receive" });
    expect(docPermissions("ISSUE", null)).toEqual({ prepare: "inventory.issue", post: "inventory.issue" });
    expect(docPermissions("TRANSFER", null)).toEqual({ prepare: "inventory.transfer", post: "inventory.transfer" });
    expect(docPermissions("RETURN", "CUSTOMER").post).toBe("inventory.receive");
    expect(docPermissions("RETURN", "SUPPLIER").post).toBe("inventory.issue");
    // Stock that changes without goods moving needs approval.
    expect(docPermissions("ADJUSTMENT", null)).toEqual({ prepare: "inventory.count", post: "inventory.approve" });
    expect(docPermissions("OPENING", null)).toEqual({ prepare: "inventory.approve", post: "inventory.approve" });
  });

  it("knows which warehouses a document uses and which lines bring a cost", () => {
    expect(docWarehouseSides("RECEIPT", null)).toEqual({ from: false, to: true });
    expect(docWarehouseSides("ISSUE", null)).toEqual({ from: true, to: false });
    expect(docWarehouseSides("TRANSFER", null)).toEqual({ from: true, to: true });
    expect(docWarehouseSides("RETURN", "SUPPLIER")).toEqual({ from: true, to: false });
    expect(docWarehouseSides("ADJUSTMENT", null)).toEqual({ from: false, to: true });
    expect(lineTakesCost("RECEIPT", null, null)).toBe(true);
    expect(lineTakesCost("RETURN", "CUSTOMER", null)).toBe(true);
    expect(lineTakesCost("RETURN", "SUPPLIER", null)).toBe(false);
    expect(lineTakesCost("ADJUSTMENT", null, "INCREASE")).toBe(true);
    expect(lineTakesCost("ADJUSTMENT", null, "DECREASE")).toBe(false);
    expect(lineTakesCost("TRANSFER", null, null)).toBe(false);
  });

  it("numbers documents per prefix and year", () => {
    expect(formatDocNumber("GRN", 2026, 7)).toBe("GRN-2026-000007");
    expect(formatDocNumber("STK", 2027, 123456)).toBe("STK-2027-123456");
  });

  it("formats quantities without trailing zeros, with Western digits in Arabic", () => {
    expect(formatQuantity(2.5, "en")).toBe("2.5");
    expect(formatQuantity(1250, "en")).toBe("1,250");
    expect(formatQuantity(0.125, "ar")).toMatch(/^0[.٫]125$/);
    expect(formatQuantity(-3, "en")).toBe("-3");
  });
});

describe("input schemas", () => {
  it("normalises SKUs and barcodes and refuses malformed ones", () => {
    const p = productSchema.parse({ sku: " lk 100 ", barcode: " 622 1234 ", nameEn: "Lock", nameAr: "قفل", unitId: "unit-pcs", purchaseCost: "1,250.50", minStock: "" });
    expect(p).toMatchObject({ sku: "LK100", barcode: "6221234", purchaseCost: 1250.5, minStock: 0, trackSerials: false, isActive: true });
    expect(normalizeCode("van-karim ")).toBe("VAN-KARIM");
    expect(Object.keys(errors(productSchema, { sku: "-bad", nameEn: "x", nameAr: "y", unitId: "u" }))).toContain("sku");
    expect(Object.keys(errors(productSchema, { sku: "OK", nameEn: "x", nameAr: "y", unitId: "u", purchaseCost: "1.234" }))).toContain("purchaseCost");
    expect(Object.keys(errors(productSchema, { sku: "OK", nameEn: "", nameAr: "", unitId: "" }))).toEqual(expect.arrayContaining(["nameEn", "nameAr", "unitId"]));
  });

  it("requires a technician for a vehicle and only for a vehicle", () => {
    expect(errors(warehouseSchema, { code: "VAN-1", nameEn: "Van", nameAr: "عربية", kind: "VEHICLE" })).toHaveProperty("technicianId");
    expect(errors(warehouseSchema, { code: "W1", nameEn: "W", nameAr: "م", kind: "WAREHOUSE", technicianId: "t1" })).toHaveProperty("technicianId");
    expect(errors(warehouseSchema, { code: "w 1", nameEn: "W", nameAr: "م", kind: "WAREHOUSE" })).toEqual({});
  });

  it("checks document structure before anything reaches the database", () => {
    const base = { documentDate: "2026-11-01", lines: [{ productId: "p1", quantity: "2" }] };
    expect(errors(stockDocSchema, { ...base, type: "RECEIPT" })).toHaveProperty("toWarehouseId");
    expect(errors(stockDocSchema, { ...base, type: "ISSUE" })).toHaveProperty("fromWarehouseId");
    expect(errors(stockDocSchema, { ...base, type: "RETURN", toWarehouseId: "w" })).toHaveProperty("returnKind");
    expect(errors(stockDocSchema, { ...base, type: "RECEIPT", toWarehouseId: "w", lines: [] })).toHaveProperty("lines");
    expect(errors(stockDocSchema, { ...base, type: "RECEIPT", toWarehouseId: "w", lines: [{ productId: "p1", quantity: 0 }] })).toHaveProperty(["lines.0.quantity"]);
    expect(errors(stockDocSchema, { ...base, type: "RECEIPT", toWarehouseId: "w", lines: [{ productId: "p1", quantity: 1.2345 }] })).toHaveProperty(["lines.0.quantity"]);
    const adj = errors(stockDocSchema, { ...base, type: "ADJUSTMENT", toWarehouseId: "w" });
    expect(adj).toHaveProperty(["lines.0.direction"]);
    expect(adj).toHaveProperty(["lines.0.reason"]);
    // A transfer inside one warehouse must change bins.
    expect(errors(stockDocSchema, { ...base, type: "TRANSFER", fromWarehouseId: "w", toWarehouseId: "w" })).toHaveProperty(["lines.0.toBinId"]);
    expect(errors(stockDocSchema, { ...base, type: "TRANSFER", fromWarehouseId: "w", toWarehouseId: "w", lines: [{ productId: "p1", quantity: 1, toBinId: "b1" }] })).toEqual({});
    // Serials typed one per line are normalised and de-duplicated.
    const parsed = stockDocSchema.parse({ ...base, type: "RECEIPT", toWarehouseId: "w", lines: [{ productId: "p1", quantity: 2, serials: "sn-1\nSN-1\n sn 2 " }] });
    expect(parsed.lines[0]!.serials).toEqual(["SN-1", "SN2"]);
  });

  it("gives field errors as message keys that read well in both languages", () => {
    const e = errors(stockDocSchema, { type: "ISSUE", documentDate: "2026-11-01", lines: [{ productId: "p1", quantity: -1 }] });
    expect(en.msg(e.fromWarehouseId)).toBe("Choose the warehouse the stock comes from");
    expect(ar.msg(e.fromWarehouseId)).toBe("اختر المخزن الذي تخرج منه البضاعة");
    expect(en.msg(e["lines.0.quantity"])).toBe("Enter a quantity greater than zero");
    const p = errors(productSchema, { sku: "OK", nameEn: "", nameAr: "x", unitId: "u" });
    expect(en.msg(p.nameEn)).toBe("Name (English) is required");
    expect(ar.msg(p.nameEn)).toBe("الاسم (إنجليزي) مطلوب");
  });
});

describe("inventory roles", () => {
  it("lets only approvers, catalogue managers and report readers see costs", () => {
    expect(canSeeCosts(permissionsFor({ role: "WAREHOUSE_MANAGER" }, settings))).toBe(true);
    expect(canSeeCosts(permissionsFor({ role: "ACCOUNTANT" }, settings))).toBe(true);
    expect(canSeeCosts(permissionsFor({ role: "ADMIN" }, settings))).toBe(true);
    expect(canSeeCosts(permissionsFor({ role: "STORE" }, settings))).toBe(false);
    expect(canSeeCosts(permissionsFor({ role: "TECHNICIAN" }, settings))).toBe(false);
    expect(canSeeCosts(permissionsFor({ role: "SALES" }, settings))).toBe(false);
  });

  it("lets a viewer be granted read-only inventory access, never stock movements", () => {
    const viewer = permissionsFor({ role: "VIEWER", viewerPermissions: ["inventory.view", "inventory.reports", "inventory.receive", "products.manage"] }, settings);
    expect([...viewer].sort()).toEqual(["inventory.reports", "inventory.view"]);
  });

  it("names the Warehouse Manager role in both languages", () => {
    expect(en.dyn("enums.role.WAREHOUSE_MANAGER")).toBe("Warehouse manager");
    expect(ar.dyn("enums.role.WAREHOUSE_MANAGER")).toBe("مدير المخازن");
  });
});
