"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { PackagePlus, Tags } from "lucide-react";
import type { ProductCategory } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { Badge } from "@/components/ui/misc";
import { useT } from "@/i18n/client";
import { api, ApiError } from "@/lib/api-client";
import { PRODUCT_CATEGORIES, parseSerials } from "@/lib/constants";

type Model = { id: string; name: string; category: ProductCategory; warrantyMonths: number; isActive: boolean };

function useSubmit() {
  const t = useT();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  async function run(fn: () => Promise<string>) {
    setBusy(true);
    setErrors({});
    try {
      toast.success(await fn());
      router.refresh();
      return true;
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError(t("common.couldNotSave"), 0, "UNKNOWN");
      setErrors(err.fieldErrors);
      toast.error(err.message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { busy, errors, run };
}

/** Goods in: one serial number per line, all of the same model. */
export function GoodsInForm({ models }: { models: Model[] }) {
  const t = useT();
  const [modelId, setModelId] = useState("");
  const [serials, setSerials] = useState("");
  const [note, setNote] = useState("");
  const { busy, errors, run } = useSubmit();
  const count = parseSerials(serials).length;

  return (
    <Card>
      <CardHeader title={t("inventory.goodsIn")} description={t("inventory.goodsInText")} icon={<PackagePlus className="h-4 w-4" />} />
      <form
        className="space-y-4 p-5"
        noValidate
        onSubmit={async (e) => {
          e.preventDefault();
          const ok = await run(async () => {
            const res = await api<{ count: number }>("/api/stock", { method: "POST", body: { modelId, serials, note } });
            return t("inventory.added", { count: res.count });
          });
          if (ok) {
            setSerials("");
            setNote("");
          }
        }}
      >
        <Field label={t("csv.model")} required error={errors.modelId}>
          {(p) => (
            <Select {...p} value={modelId} onChange={(e) => setModelId(e.target.value)}>
              <option value="">{models.length ? t("common.choose") : t("inventory.addModelFirst")}</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t("historyFields.serials")} required error={errors.serials} hint={count ? t("inventory.serialCount", { count }) : undefined}>
          {(p) => <Textarea {...p} rows={4} dir="ltr" className="font-mono" value={serials} onChange={(e) => setSerials(e.target.value)} />}
        </Field>
        <Field label={t("common.note")} error={errors.note} hint={t("inventory.noteHint")}>
          {(p) => <Input {...p} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />}
        </Field>
        <Button type="submit" loading={busy} disabled={!modelId || !count}>
          {t("inventory.addToStore")}
        </Button>
      </form>
    </Card>
  );
}

/** Product models with their warranty (months); a model in use can be deactivated, not deleted. */
export function ModelsManager({ models }: { models: Model[] }) {
  const t = useT();
  const empty = { id: "", name: "", category: "SMART_LOCK" as ProductCategory, warrantyMonths: "12", isActive: true };
  const [draft, setDraft] = useState(empty);
  const { busy, errors, run } = useSubmit();

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const body = { name: draft.name, category: draft.category, warrantyMonths: draft.warrantyMonths, isActive: draft.isActive };
    const ok = await run(async () => {
      if (draft.id) await api(`/api/stock/models/${draft.id}`, { method: "PATCH", body });
      else await api("/api/stock/models", { method: "POST", body });
      return draft.id ? t("inventory.modelUpdated") : t("inventory.modelAdded");
    });
    if (ok) setDraft(empty);
  }

  return (
    <Card>
      <CardHeader title={t("inventory.models")} description={t("inventory.modelsText")} icon={<Tags className="h-4 w-4" />} />
      <div className="space-y-4 p-5">
        {models.length > 0 && (
          <ul className="max-h-48 divide-y divide-line overflow-y-auto rounded-lg border border-line">
            {models.map((m) => (
              <li key={m.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate font-medium text-fg">{m.name}</span>
                <span className="text-xs text-fg-subtle">{t.dyn(`enums.productCategory.${m.category}`)}</span>
                <span className="text-xs tabular-nums text-fg-muted">{t("inventory.months", { count: m.warrantyMonths })}</span>
                {!m.isActive && <Badge>{t("common.inactive")}</Badge>}
                <button
                  type="button"
                  className="text-xs font-medium text-brand-text hover:underline"
                  onClick={() => setDraft({ id: m.id, name: m.name, category: m.category, warrantyMonths: String(m.warrantyMonths), isActive: m.isActive })}
                >
                  {t("common.edit")}
                </button>
              </li>
            ))}
          </ul>
        )}
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={save} noValidate>
          <Field label={draft.id ? t("inventory.modelNameEditing") : t("inventory.newModelName")} required error={errors.name} className="sm:col-span-2">
            {(p) => <Input {...p} value={draft.name} maxLength={120} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />}
          </Field>
          <Field label={t("filters.category")} required error={errors.category}>
            {(p) => (
              <Select {...p} value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value as ProductCategory })}>
                {PRODUCT_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {t.dyn(`enums.productCategory.${c}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t("inventory.warrantyMonths")} required error={errors.warrantyMonths}>
            {(p) => <Input {...p} inputMode="numeric" value={draft.warrantyMonths} onChange={(e) => setDraft({ ...draft, warrantyMonths: e.target.value })} />}
          </Field>
          {draft.id && (
            <label className="flex items-center gap-2 text-sm text-fg sm:col-span-2">
              <input type="checkbox" checked={draft.isActive} onChange={(e) => setDraft({ ...draft, isActive: e.target.checked })} /> {t("inventory.activeModel")}
            </label>
          )}
          <div className="flex gap-2 sm:col-span-2">
            <Button type="submit" loading={busy} disabled={!draft.name.trim()}>
              {draft.id ? t("inventory.saveModel") : t("inventory.addModel")}
            </Button>
            {draft.id && (
              <Button type="button" variant="ghost" onClick={() => setDraft(empty)}>
                {t("common.cancel")}
              </Button>
            )}
          </div>
        </form>
      </div>
    </Card>
  );
}
