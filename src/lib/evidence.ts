/**
 * Work evidence: what a visit needs before it can be marked done, by visit type and product
 * category, and what is still missing. Pure (shared by the server and the browser).
 */
import { z } from "zod";
import type { ProductCategory, VisitType } from "@prisma/client";
import type { MessageKey } from "@/i18n/translator";
import { msg } from "@/i18n/translator";
import { PRODUCT_CATEGORIES, VISIT_TYPES } from "./constants";

export type EvidenceRequirement = {
  minBeforePhotos: number;
  minAfterPhotos: number;
  requireVideo: boolean;
  requireSignature: boolean;
  requireCustomerConfirmation: boolean;
  /** A manager approves the submitted work (otherwise "done" is final). */
  requireReview: boolean;
};

export type EvidenceRule = EvidenceRequirement & { id: string; visitType: VisitType | null; productCategory: ProductCategory | null; isActive: boolean };

export const NO_REQUIREMENT: EvidenceRequirement = { minBeforePhotos: 0, minAfterPhotos: 0, requireVideo: false, requireSignature: false, requireCustomerConfirmation: false, requireReview: false };

/**
 * The rule for a visit: the most specific active one (visit type and category, then visit type,
 * then category, then the rule for every visit), or no requirement.
 */
export function ruleFor<R extends EvidenceRule>(rules: R[], visitType: VisitType | null, category: ProductCategory): R | null {
  const active = rules.filter((r) => r.isActive);
  const exact = (vt: VisitType | null, c: ProductCategory | null) => active.find((r) => r.visitType === vt && r.productCategory === c);
  return (visitType && exact(visitType, category)) || (visitType && exact(visitType, null)) || exact(null, category) || exact(null, null) || null;
}

export type EvidenceState = { beforePhotos: number; afterPhotos: number; videos: number; hasSignature: boolean; customerConfirmed: boolean };

/** What is still missing (message keys with counts); empty = the evidence is complete. */
export function evidenceMissing(req: EvidenceRequirement, s: EvidenceState): { key: MessageKey; count?: number }[] {
  const out: { key: MessageKey; count?: number }[] = [];
  if (s.beforePhotos < req.minBeforePhotos) out.push({ key: "evidence.missing.before", count: req.minBeforePhotos - s.beforePhotos });
  if (s.afterPhotos < req.minAfterPhotos) out.push({ key: "evidence.missing.after", count: req.minAfterPhotos - s.afterPhotos });
  if (req.requireVideo && !s.videos) out.push({ key: "evidence.missing.video" });
  if (req.requireSignature && !s.hasSignature) out.push({ key: "evidence.missing.signature" });
  if (req.requireCustomerConfirmation && !s.customerConfirmed) out.push({ key: "evidence.missing.confirmation" });
  return out;
}

const count = z.preprocess((v) => (v === "" || v === undefined ? 0 : Number(v)), z.number().int().min(0).max(20, msg("evidence.errors.tooMany")));
const bool = z.preprocess((v) => v === true || v === "true" || v === "on", z.boolean());

export const evidenceRuleSchema = z.object({
  visitType: z.preprocess((v) => (v === "" || v === undefined ? null : v), z.enum(VISIT_TYPES as unknown as [VisitType, ...VisitType[]]).nullable()),
  productCategory: z.preprocess((v) => (v === "" || v === undefined ? null : v), z.enum(PRODUCT_CATEGORIES as unknown as [ProductCategory, ...ProductCategory[]]).nullable()),
  minBeforePhotos: count,
  minAfterPhotos: count,
  requireVideo: bool,
  requireSignature: bool,
  requireCustomerConfirmation: bool,
  requireReview: bool,
  isActive: z.preprocess((v) => (v === undefined ? true : v === true || v === "true" || v === "on"), z.boolean()),
});

export const submitWorkSchema = z.object({
  customerConfirmed: bool.optional(),
  customerName: z.preprocess((v) => (typeof v === "string" ? v.trim() || null : (v ?? null)), z.string().max(120).nullable()),
  note: z.preprocess((v) => (typeof v === "string" ? v.trim() || null : (v ?? null)), z.string().max(1000).nullable()),
});

export const decideWorkSchema = z
  .object({ decision: z.enum(["APPROVED", "REJECTED"]), note: z.preprocess((v) => (typeof v === "string" ? v.trim() || null : (v ?? null)), z.string().max(1000).nullable()) })
  .refine((v) => v.decision !== "REJECTED" || !!v.note, { path: ["note"], message: msg("evidence.errors.reason") });

export type WorkReviewEventValue = "SUBMITTED" | "APPROVED" | "REJECTED";

/** A visit's evidence as its reader sees it (the visit page and the API). */
export type EvidenceStatusDTO = {
  /** The rule that applies (null: nothing is required). */
  rule: (EvidenceRequirement & { visitType: VisitType | null; productCategory: ProductCategory | null }) | null;
  state: EvidenceState;
  missing: { key: MessageKey; count?: number }[];
  /** The latest review event (null: never submitted). */
  status: WorkReviewEventValue | null;
  history: { id: string; event: WorkReviewEventValue; note: string | null; customerConfirmed: boolean; customerName: string | null; actor: { id: string; name: string }; at: string }[];
  can: { review: boolean; resubmit: boolean };
};
