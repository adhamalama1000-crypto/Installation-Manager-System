/** Supplier master: input schema shared by the browser and the server (pure). */
import { z } from "zod";
import { msg } from "@/i18n/translator";
import { LOCATION_CODE_RE, normalizeCode } from "./inventory";
import { optionalPhone, optionalText } from "./validation";

const required = (label: string) => msg("validation.required", { field: `@${label}` });

export const supplierSchema = z.object({
  /** Blank on a new supplier: generated (SUP-00001). */
  code: z.preprocess((v) => {
    const n = normalizeCode(v);
    return n === "" || n === undefined ? null : n;
  }, z.string().regex(LOCATION_CODE_RE, msg("suppliers.errors.code")).nullable()),
  name: z.preprocess((v) => (typeof v === "string" ? v.trim() : v), z.string({ error: required("suppliers.name") }).min(1, required("suppliers.name")).max(200, msg("validation.maxChars", { max: 200 }))),
  nameAr: optionalText(200),
  contactPerson: optionalText(120),
  phone: optionalPhone,
  email: z.preprocess((v) => (typeof v === "string" ? v.trim() || null : (v ?? null)), z.string().max(200).email(msg("suppliers.errors.email")).nullable()),
  address: optionalText(500),
  taxNumber: optionalText(60),
  notes: optionalText(2000),
  isActive: z.preprocess((v) => (v === "false" ? false : v === "true" ? true : (v ?? true)), z.boolean()),
  version: z.preprocess((v) => (v === "" || v === undefined ? undefined : Number(v)), z.number().int().min(1).optional()),
});
export type SupplierInput = z.output<typeof supplierSchema>;
