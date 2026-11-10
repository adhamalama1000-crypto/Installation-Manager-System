import { describe, expect, it } from "vitest";
import { NO_REQUIREMENT, decideWorkSchema, evidenceMissing, evidenceRuleSchema, ruleFor, type EvidenceRule } from "@/lib/evidence";

const rule = (over: Partial<EvidenceRule>): EvidenceRule => ({ ...NO_REQUIREMENT, id: Math.random().toString(36), visitType: null, productCategory: null, isActive: true, ...over });

describe("ruleFor", () => {
  const all = rule({ id: "all", minAfterPhotos: 1 });
  const cat = rule({ id: "cat", productCategory: "CCTV" });
  const type = rule({ id: "type", visitType: "INSTALLATION" });
  const exact = rule({ id: "exact", visitType: "INSTALLATION", productCategory: "CCTV" });

  it("picks the most specific active rule", () => {
    const rules = [all, cat, type, exact];
    expect(ruleFor(rules, "INSTALLATION", "CCTV")?.id).toBe("exact");
    expect(ruleFor(rules, "INSTALLATION", "SMART_LOCK")?.id).toBe("type");
    expect(ruleFor(rules, "MAINTENANCE", "CCTV")?.id).toBe("cat");
    expect(ruleFor(rules, "MAINTENANCE", "SMART_LOCK")?.id).toBe("all");
    // A visit without a type matches category and catch-all rules only.
    expect(ruleFor(rules, null, "CCTV")?.id).toBe("cat");
  });

  it("skips inactive rules, and none is no requirement", () => {
    expect(ruleFor([{ ...exact, isActive: false }, type], "INSTALLATION", "CCTV")?.id).toBe("type");
    expect(ruleFor([], "INSTALLATION", "CCTV")).toBeNull();
  });
});

describe("evidenceMissing", () => {
  const req = { ...NO_REQUIREMENT, minBeforePhotos: 2, minAfterPhotos: 3, requireVideo: true, requireSignature: true, requireCustomerConfirmation: true };
  it("lists what is missing, with counts", () => {
    expect(evidenceMissing(req, { beforePhotos: 1, afterPhotos: 0, videos: 0, hasSignature: false, customerConfirmed: false })).toEqual([
      { key: "evidence.missing.before", count: 1 },
      { key: "evidence.missing.after", count: 3 },
      { key: "evidence.missing.video" },
      { key: "evidence.missing.signature" },
      { key: "evidence.missing.confirmation" },
    ]);
    expect(evidenceMissing(req, { beforePhotos: 2, afterPhotos: 4, videos: 1, hasSignature: true, customerConfirmed: true })).toEqual([]);
    expect(evidenceMissing(NO_REQUIREMENT, { beforePhotos: 0, afterPhotos: 0, videos: 0, hasSignature: false, customerConfirmed: false })).toEqual([]);
  });
});

describe("schemas", () => {
  it("reads rule forms ('' = any, checkboxes, blank counts)", () => {
    const r = evidenceRuleSchema.parse({ visitType: "", productCategory: "CCTV", minBeforePhotos: "", minAfterPhotos: "2", requireVideo: "on" });
    expect(r).toMatchObject({ visitType: null, productCategory: "CCTV", minBeforePhotos: 0, minAfterPhotos: 2, requireVideo: true, requireReview: false, isActive: true });
    expect(evidenceRuleSchema.safeParse({ minAfterPhotos: "2.5" }).success).toBe(false);
  });
  it("needs a reason to reject", () => {
    expect(decideWorkSchema.safeParse({ decision: "REJECTED", note: " " }).success).toBe(false);
    expect(decideWorkSchema.safeParse({ decision: "REJECTED", note: "Blurry" }).success).toBe(true);
    expect(decideWorkSchema.parse({ decision: "APPROVED" })).toEqual({ decision: "APPROVED", note: null });
    expect(decideWorkSchema.safeParse({ decision: "MAYBE" }).success).toBe(false);
  });
});
