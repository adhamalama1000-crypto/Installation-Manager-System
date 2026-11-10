/** Sales invoices: input schemas and the amount rules, shared by the browser and the server (pure). */
import { z } from "zod";
import type { PaymentMethod, SalesInvoiceStatus } from "@prisma/client";
import { msg } from "@/i18n/translator";
import { PAYMENT_METHODS } from "./constants";
import { hasAtMostDecimals, quantityField } from "./inventory";
import { isValidDateString } from "./time";
import { optionalPhone, optionalText } from "./validation";
import { parseSerials, SERIAL_RE } from "./constants";

export const SALES_STATUSES: SalesInvoiceStatus[] = ["DRAFT", "CONFIRMED", "CANCELLED"];
export const SALES_PREFIX = "INV";

const toNumber = (v: unknown) => (typeof v === "string" ? (v.trim() === "" ? undefined : Number(v.replace(/[,\s]/g, ""))) : v);
const money = (opts: { required?: boolean } = {}) =>
  z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? (opts.required ? undefined : 0) : toNumber(v)),
    z
      .number({ error: msg("validation.amount") })
      .min(0, msg("validation.negative"))
      .max(10_000_000, msg("validation.tooLarge"))
      .refine((n) => hasAtMostDecimals(n, 2), msg("validation.twoDecimals")),
  );

const optionalId = z.preprocess((v) => (v === "" || v === undefined ? null : v), z.string().min(1).max(64).nullable());

export const saleLineSchema = z.object({
  productId: z.preprocess((v) => (v === "" ? undefined : v), z.string({ error: msg("validation.required", { field: "@stock.fields.product" }) }).min(1).max(64)),
  quantity: quantityField,
  unitPrice: money({ required: true }),
  /** Amount off this line. */
  discount: money(),
  serials: z.preprocess(
    (v) => (Array.isArray(v) ? parseSerials(v.join("\n")) : typeof v === "string" ? parseSerials(v) : (v ?? [])),
    z
      .array(z.string())
      .max(1000)
      .superRefine((list, ctx) => {
        const bad = list.filter((s) => !SERIAL_RE.test(s));
        if (bad.length) ctx.addIssue({ code: "custom", message: msg("validation.badSerial", { list: bad.slice(0, 5).join(", ") }) });
      }),
  ),
});

export const saleSchema = z
  .object({
    invoiceDate: z.string({ error: msg("validation.dateRequired") }).refine(isValidDateString, msg("validation.date")),
    /** An existing customer; or a walk-in customer by name (and phone). */
    customerId: optionalId,
    customerName: optionalText(200),
    customerPhone: optionalPhone,
    appointmentRef: optionalText(20),
    warehouseId: z.preprocess((v) => (v === "" ? undefined : v), z.string({ error: msg("stock.errors.fromWarehouse") }).min(1).max(64)),
    paymentMethod: z.preprocess((v) => (v === "" || v === undefined ? null : v), z.enum(PAYMENT_METHODS as unknown as [PaymentMethod, ...PaymentMethod[]]).nullable()),
    note: optionalText(1000),
    clientRequestId: z.preprocess((v) => (v === "" ? undefined : v), z.string().min(8).max(64).optional()),
    version: z.preprocess(toNumber, z.number().int().min(1).optional()),
    lines: z.array(saleLineSchema).min(1, msg("stock.errors.noLines")).max(200, msg("stock.errors.tooManyLines")),
  })
  .superRefine((v, ctx) => {
    if (!v.customerId && !v.customerName) ctx.addIssue({ code: "custom", path: ["customerName"], message: msg("sales.errors.customer") });
    v.lines.forEach((l, i) => {
      if (l.discount > l.quantity * l.unitPrice + 1e-9) ctx.addIssue({ code: "custom", path: ["lines", i, "discount"], message: msg("sales.errors.discount") });
    });
  });
export type SaleInput = z.output<typeof saleSchema>;

export const cancelSaleSchema = z.object({ reason: optionalText(500), version: z.preprocess(toNumber, z.number().int().min(1).optional()) });

/** Rounds to the piastre (amounts are stored with two decimals). */
export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** A line's total and the invoice's totals, exactly as the database checks them. */
export function lineTotal(l: { quantity: number; unitPrice: number; discount: number }): number {
  return round2(l.quantity * l.unitPrice - l.discount);
}
export function invoiceTotals(lines: { quantity: number; unitPrice: number; discount: number }[]) {
  const totals = lines.map(lineTotal);
  const discountTotal = round2(lines.reduce((s, l) => s + l.discount, 0));
  const total = round2(totals.reduce((s, x) => s + x, 0));
  return { subtotal: round2(total + discountTotal), discountTotal, total };
}
