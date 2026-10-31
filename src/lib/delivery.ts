/**
 * What a technician hands over at the end of an installation (Aura v5 delivery rules): the
 * checklist for the product, a photo of the finished work, the customer's signature and, for a
 * transfer, a screenshot of it. Pure functions, shared by the browser (live hints) and the server
 * (enforcement when the Admin turns the rule on).
 */
import type { PaymentMethod, ProductCategory, VisitType } from "@prisma/client";
import type { MessageKey } from "@/i18n/translator";

export const CHECKLISTS = {
  lock: ["lock.access", "lock.app", "lock.handover", "lock.door"],
  smart: ["smart.paired", "smart.app", "smart.scenes", "smart.tidy"],
} as const;

export type ChecklistGroup = keyof typeof CHECKLISTS;

export function checklistGroup(category: ProductCategory): ChecklistGroup {
  return category === "SMART_LOCK" ? "lock" : "smart";
}

export function checklistItems(category: ProductCategory): readonly string[] {
  return CHECKLISTS[checklistGroup(category)];
}

/** Installation and completion visits hand over finished work; other visits only need a signature. */
export function isHandoverVisit(visitType: VisitType | null): boolean {
  return visitType === "INSTALLATION" || visitType === "COMPLETION";
}

export type DeliveryState = {
  productCategory: ProductCategory;
  visitType: VisitType | null;
  checklist: readonly string[];
  afterPhotos: number;
  hasSignature: boolean;
  hasPaymentProof: boolean;
  collectedAmount: number | null;
  collectedMethod: PaymentMethod | null;
  installedSerials: number;
};

export type DeliveryRules = { requireDeliveryProof: boolean; serialRequired: boolean };

/** Message keys of what is still missing before the visit can be marked done (empty = ready). */
export function deliveryMissing(s: DeliveryState, rules: DeliveryRules): { key: MessageKey; count?: number }[] {
  const missing: { key: MessageKey; count?: number }[] = [];
  const handover = isHandoverVisit(s.visitType);
  if (rules.requireDeliveryProof) {
    if (handover) {
      const left = checklistItems(s.productCategory).filter((item) => !s.checklist.includes(item)).length;
      if (left) missing.push({ key: "delivery.missing.checklist", count: left });
      if (!s.afterPhotos) missing.push({ key: "delivery.missing.afterPhoto" });
    }
    if (!s.hasSignature) missing.push({ key: "delivery.missing.signature" });
    if (s.collectedAmount && s.collectedMethod && s.collectedMethod !== "CASH" && !s.hasPaymentProof) missing.push({ key: "delivery.missing.paymentProof" });
  }
  if (rules.serialRequired && handover && !s.installedSerials) missing.push({ key: "delivery.missing.serial" });
  return missing;
}
