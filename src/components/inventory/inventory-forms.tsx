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
import { api, ApiError } from "@/lib/api-client";
import { PRODUCT_CATEGORIES, PRODUCT_CATEGORY_LABELS, parseSerials } from "@/lib/constants";

type Model = { id: string; name: string; category: ProductCategory; warrantyMonths: number; isActive: boolean };

function useSubmit() {
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
      const err = e instanceof ApiError ? e : new ApiError("Could not save", 0, "UNKNOWN");
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
  const [modelId, setModelId] = useState("");
  const [serials, setSerials] = useState("");
  const [note, setNote] = useState("");
  const { busy, errors, run } = useSubmit();
  const count = parseSerials(serials).length;

  return (
    <Card>
      <CardHeader title="Goods in" description="Scan or type one serial number per line." icon={<PackagePlus className="h-4 w-4" />} />
      <form
        className="space-y-4 p-5"
        noValidate
        onSubmit={async (e) => {
          e.preventDefault();
          const ok = await run(async () => {
            const res = await api<{ count: number }>("/api/stock", { method: "POST", body: { modelId, serials, note } });
            return `${res.count} item${res.count === 1 ? "" : "s"} added to the store`;
          });
          if (ok) {
            setSerials("");
            setNote("");
          }
        }}
      >
        <Field label="Model" required error={errors.modelId}>
          {(p) => (
            <Select {...p} value={modelId} onChange={(e) => setModelId(e.target.value)}>
              <option value="">{models.length ? "Choose…" : "Add a model first"}</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Serial numbers" required error={errors.serials} hint={count ? `${count} serial number${count === 1 ? "" : "s"}` : undefined}>
          {(p) => <Textarea {...p} rows={4} className="font-mono" value={serials} onChange={(e) => setSerials(e.target.value)} />}
        </Field>
        <Field label="Note" error={errors.note} hint="Optional, e.g. supplier invoice number">
          {(p) => <Input {...p} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />}
        </Field>
        <Button type="submit" loading={busy} disabled={!modelId || !count}>
          Add to store
        </Button>
      </form>
    </Card>
  );
}

/** Product models with their warranty (months); a model in use can be deactivated, not deleted. */
export function ModelsManager({ models }: { models: Model[] }) {
  const empty = { id: "", name: "", category: "SMART_LOCK" as ProductCategory, warrantyMonths: "12", isActive: true };
  const [draft, setDraft] = useState(empty);
  const { busy, errors, run } = useSubmit();

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const body = { name: draft.name, category: draft.category, warrantyMonths: draft.warrantyMonths, isActive: draft.isActive };
    const ok = await run(async () => {
      if (draft.id) await api(`/api/stock/models/${draft.id}`, { method: "PATCH", body });
      else await api("/api/stock/models", { method: "POST", body });
      return draft.id ? "Model updated" : "Model added";
    });
    if (ok) setDraft(empty);
  }

  return (
    <Card>
      <CardHeader title="Models & warranty" description="The warranty starts on the visit date when an item is installed." icon={<Tags className="h-4 w-4" />} />
      <div className="space-y-4 p-5">
        {models.length > 0 && (
          <ul className="max-h-48 divide-y divide-line overflow-y-auto rounded-lg border border-line">
            {models.map((m) => (
              <li key={m.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate font-medium text-fg">{m.name}</span>
                <span className="text-xs text-fg-subtle">{PRODUCT_CATEGORY_LABELS[m.category]}</span>
                <span className="text-xs tabular-nums text-fg-muted">{m.warrantyMonths} mo</span>
                {!m.isActive && <Badge>inactive</Badge>}
                <button
                  type="button"
                  className="text-xs font-medium text-brand-text hover:underline"
                  onClick={() => setDraft({ id: m.id, name: m.name, category: m.category, warrantyMonths: String(m.warrantyMonths), isActive: m.isActive })}
                >
                  Edit
                </button>
              </li>
            ))}
          </ul>
        )}
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={save} noValidate>
          <Field label={draft.id ? "Model name (editing)" : "New model name"} required error={errors.name} className="sm:col-span-2">
            {(p) => <Input {...p} value={draft.name} maxLength={120} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />}
          </Field>
          <Field label="Category" required error={errors.category}>
            {(p) => (
              <Select {...p} value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value as ProductCategory })}>
                {PRODUCT_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {PRODUCT_CATEGORY_LABELS[c]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Warranty (months)" required error={errors.warrantyMonths}>
            {(p) => <Input {...p} inputMode="numeric" value={draft.warrantyMonths} onChange={(e) => setDraft({ ...draft, warrantyMonths: e.target.value })} />}
          </Field>
          {draft.id && (
            <label className="flex items-center gap-2 text-sm text-fg sm:col-span-2">
              <input type="checkbox" checked={draft.isActive} onChange={(e) => setDraft({ ...draft, isActive: e.target.checked })} /> Active (can receive goods)
            </label>
          )}
          <div className="flex gap-2 sm:col-span-2">
            <Button type="submit" loading={busy} disabled={!draft.name.trim()}>
              {draft.id ? "Save model" : "Add model"}
            </Button>
            {draft.id && (
              <Button type="button" variant="ghost" onClick={() => setDraft(empty)}>
                Cancel
              </Button>
            )}
          </div>
        </form>
      </div>
    </Card>
  );
}
