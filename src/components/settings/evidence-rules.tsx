"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import type { ProductCategory, VisitType } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Checkbox, Field, Input, Select } from "@/components/ui/field";
import { Badge } from "@/components/ui/misc";
import { useAction } from "@/components/erp/use-action";
import { useT } from "@/i18n/client";
import { api } from "@/lib/api-client";
import { PRODUCT_CATEGORIES, VISIT_TYPES } from "@/lib/constants";
import type { EvidenceRule } from "@/lib/evidence";

/** The work evidence rules, by visit type and product category (Admins; the server checks again). */
export function EvidenceRules({ rules }: { rules: EvidenceRule[] }) {
  const t = useT();
  const [editing, setEditing] = useState<EvidenceRule | "new" | null>(null);
  const visit = (v: VisitType | null) => (v ? t.dyn(`enums.visitType.${v}`) : t("evidence.anyVisit"));
  const category = (c: ProductCategory | null) => (c ? t.dyn(`enums.productCategory.${c}`) : t("evidence.anyCategory"));

  function requires(r: EvidenceRule): string {
    const parts = [
      r.minBeforePhotos ? t("evidence.rules.before", { photos: t("evidence.rules.photos", { count: r.minBeforePhotos }) }) : null,
      r.minAfterPhotos ? t("evidence.rules.after", { photos: t("evidence.rules.photos", { count: r.minAfterPhotos }) }) : null,
      r.requireVideo ? t("evidence.rules.video") : null,
      r.requireSignature ? t("evidence.rules.signature") : null,
      r.requireCustomerConfirmation ? t("evidence.rules.confirmation") : null,
      r.requireReview ? t("evidence.rules.review") : null,
    ].filter(Boolean);
    return parts.length ? parts.join(" · ") : t("evidence.rules.nothing");
  }

  return (
    <div>
      <div className="flex justify-end px-5 pb-3">
        <Button size="sm" variant="outline" onClick={() => setEditing("new")}>
          <Plus className="h-4 w-4" /> {t("evidence.rules.add")}
        </Button>
      </div>
      {rules.length === 0 ? (
        <p className="px-5 pb-5 text-sm text-fg-muted">{t("evidence.rules.none")}</p>
      ) : (
        <ul className="divide-y divide-line border-t border-line" aria-label={t("evidence.rules.title")}>
          {rules.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3 text-sm">
              <span className="font-medium text-fg">
                {visit(r.visitType)} · {category(r.productCategory)}
              </span>
              {!r.isActive && <Badge>{t("evidence.rules.inactive")}</Badge>}
              <span className="w-full text-xs text-fg-muted sm:w-auto">{requires(r)}</span>
              <Button size="sm" variant="ghost" className="ms-auto" onClick={() => setEditing(r)} aria-label={`${t("evidence.rules.edit")}: ${visit(r.visitType)} · ${category(r.productCategory)}`}>
                {t("common.edit")}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {editing && <RuleDialog initial={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function RuleDialog({ initial, onClose }: { initial: EvidenceRule | null; onClose: () => void }) {
  const t = useT();
  const { busy, errors, run } = useAction();
  const [v, setV] = useState({
    visitType: initial?.visitType ?? "",
    productCategory: initial?.productCategory ?? "",
    minBeforePhotos: String(initial?.minBeforePhotos ?? 0),
    minAfterPhotos: String(initial?.minAfterPhotos ?? 1),
    requireVideo: initial?.requireVideo ?? false,
    requireSignature: initial?.requireSignature ?? false,
    requireCustomerConfirmation: initial?.requireCustomerConfirmation ?? false,
    requireReview: initial?.requireReview ?? false,
    isActive: initial?.isActive ?? true,
  });
  async function save() {
    const r = await run(() => api("/api/evidence/rules", { method: "PUT", body: v }), () => t("evidence.rules.saved"));
    if (r) onClose();
  }
  const flag = (key: "requireVideo" | "requireSignature" | "requireCustomerConfirmation" | "requireReview" | "isActive", label: string) => (
    <Checkbox label={label} checked={v[key]} onChange={(e) => setV({ ...v, [key]: e.target.checked })} />
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={initial ? t("evidence.rules.edit") : t("evidence.rules.add")}
      description={t("evidence.rules.text")}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button loading={busy} onClick={() => void save()}>
            {t("evidence.rules.save")}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {/* The visit type and category are what a rule is for: an existing rule keeps them. */}
        <Field label={t("evidence.rules.visitType")} error={errors.visitType}>
          {(p) => (
            <Select {...p} value={v.visitType} disabled={!!initial} onChange={(e) => setV({ ...v, visitType: e.target.value as VisitType | "" })}>
              <option value="">{t("evidence.anyVisit")}</option>
              {VISIT_TYPES.map((x) => (
                <option key={x} value={x}>
                  {t.dyn(`enums.visitType.${x}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t("evidence.rules.category")} error={errors.productCategory}>
          {(p) => (
            <Select {...p} value={v.productCategory} disabled={!!initial} onChange={(e) => setV({ ...v, productCategory: e.target.value as ProductCategory | "" })}>
              <option value="">{t("evidence.anyCategory")}</option>
              {PRODUCT_CATEGORIES.map((x) => (
                <option key={x} value={x}>
                  {t.dyn(`enums.productCategory.${x}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t("evidence.rules.minBefore")} error={errors.minBeforePhotos}>
          {(p) => <Input {...p} type="number" min={0} max={20} inputMode="numeric" dir="ltr" value={v.minBeforePhotos} onChange={(e) => setV({ ...v, minBeforePhotos: e.target.value })} />}
        </Field>
        <Field label={t("evidence.rules.minAfter")} error={errors.minAfterPhotos}>
          {(p) => <Input {...p} type="number" min={0} max={20} inputMode="numeric" dir="ltr" value={v.minAfterPhotos} onChange={(e) => setV({ ...v, minAfterPhotos: e.target.value })} />}
        </Field>
        <div className="space-y-1 sm:col-span-2">
          {flag("requireVideo", t("evidence.rules.requireVideo"))}
          {flag("requireSignature", t("evidence.rules.requireSignature"))}
          {flag("requireCustomerConfirmation", t("evidence.rules.requireConfirmation"))}
          {flag("requireReview", t("evidence.rules.requireReview"))}
          {flag("isActive", t("evidence.rules.active"))}
        </div>
      </div>
    </Dialog>
  );
}
