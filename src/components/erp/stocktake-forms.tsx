"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { Alert } from "@/components/ui/misc";
import { useT } from "@/i18n/client";
import { api } from "@/lib/api-client";
import { parseSerials } from "@/lib/constants";
import { formatQuantity } from "@/lib/inventory";
import { cn } from "@/lib/utils";
import { ConfirmButton } from "./confirm-dialog";
import { ProductPicker, type PickedProduct } from "./document-form";
import { nameOf, tableHead, th, thEnd } from "./labels";
import { useAction } from "./use-action";

/** Starts a stocktake: choose the warehouse; the snapshot is taken when it is created. */
export function NewStocktake({ warehouses }: { warehouses: { id: string; code: string; nameEn: string; nameAr: string; frozen: boolean }[] }) {
  const t = useT();
  const router = useRouter();
  const [warehouseId, setWarehouseId] = useState("");
  const [note, setNote] = useState("");
  const { busy, errors, run } = useAction();
  return (
    <Card className="mb-6">
      <CardHeader title={t("stocktakes.new")} description={t("stocktakes.newText")} />
      <form
        className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-[16rem_1fr_auto] sm:items-end"
        noValidate
        onSubmit={async (e) => {
          e.preventDefault();
          const r = await run(
            () => api<{ stocktake: { id: string; number: string } }>("/api/stocktakes", { method: "POST", body: { warehouseId, note } }),
            (r) => t("stocktakes.started", { number: r.stocktake.number }),
            { refresh: false },
          );
          if (r) router.push(`/stocktakes/${r.stocktake.id}`);
        }}
      >
        <Field label={t("stock.fields.warehouse")} required error={errors.warehouseId}>
          {(p) => (
            <Select {...p} value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
              <option value="">{t("common.choose")}</option>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id} disabled={w.frozen}>
                  {w.code} · {nameOf(w, t)}
                  {w.frozen ? ` (${t("warehouses.frozen")})` : ""}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t("common.noteOptional")} error={errors.note}>
          {(p) => <Input {...p} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} dir="auto" />}
        </Field>
        <Button type="submit" loading={busy}>
          {t("stocktakes.new")}
        </Button>
      </form>
    </Card>
  );
}

type Line = {
  id: string;
  product: { id: string; sku: string; nameEn: string; nameAr: string; trackSerials: boolean; unit: { code: string; allowsFraction: boolean } };
  bin: string | null;
  systemQuantity: number;
  systemSerials: string[];
  countedQuantity: number | null;
  countedSerials: string[];
  reason: string | null;
  countedBy: { name: string } | null;
};
type Draft = { counted: string; serials: string; reason: string };

const draftOf = (l: Line): Draft => ({ counted: l.countedQuantity === null ? "" : String(l.countedQuantity), serials: l.countedSerials.join("\n"), reason: l.reason ?? "" });

/** The count sheet: system quantity, what was counted, the difference and its explanation. */
export function StocktakeSheet({
  id,
  number,
  warehouseId,
  bins,
  lines,
  can,
}: {
  id: string;
  number: string;
  warehouseId: string;
  bins: { id: string; code: string }[];
  lines: Line[];
  can: { count: boolean; submit: boolean; decide: boolean; cancel: boolean };
}) {
  const t = useT();
  const L = t.locale;
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() => Object.fromEntries(lines.map((l) => [l.id, draftOf(l)])));
  const [filter, setFilter] = useState<"all" | "diff" | "uncounted">("all");
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState<{ product: PickedProduct | null; binId: string }>({ product: null, binId: "" });
  const { busy, errors, run } = useAction();

  const counted = (l: Line): number | null => {
    const d = drafts[l.id] ?? draftOf(l);
    if (l.product.trackSerials) return d.serials.trim() || d.counted !== "" ? parseSerials(d.serials).length : null;
    if (d.counted.trim() === "") return null;
    const n = Number(d.counted.replace(/[,\s]/g, ""));
    return Number.isFinite(n) ? n : null;
  };
  const dirty = lines.filter((l) => {
    const a = drafts[l.id];
    const b = draftOf(l);
    return a && (a.counted !== b.counted || a.serials !== b.serials || a.reason !== b.reason);
  });
  const visible = useMemo(() => {
    const term = q.trim().toLowerCase();
    return lines.filter((l) => {
      if (term && ![l.product.sku, l.product.nameEn, l.product.nameAr].some((s) => s.toLowerCase().includes(term))) return false;
      const c = counted(l);
      if (filter === "uncounted") return c === null;
      if (filter === "diff") return c !== null && Math.abs(c - l.systemQuantity) > 1e-9;
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, drafts, filter, q]);

  async function saveCounts(): Promise<boolean> {
    if (!dirty.length) return true;
    const body = {
      lines: dirty.map((l) => {
        const d = drafts[l.id]!;
        return l.product.trackSerials
          ? { lineId: l.id, countedQuantity: d.serials.trim() ? parseSerials(d.serials).length : d.counted === "0" ? 0 : null, countedSerials: d.serials, reason: d.reason }
          : { lineId: l.id, countedQuantity: d.counted, countedSerials: [], reason: d.reason };
      }),
    };
    const r = await run(() => api(`/api/stocktakes/${id}/counts`, { method: "POST", body }), () => t("stocktakes.countsSaved"));
    return r !== null;
  }
  const act = (path: string, body: unknown, done: string) => run(() => api(`/api/stocktakes/${id}/${path}`, { method: "POST", body }), () => done).then((r) => r !== null);
  const errFor = (lineId: string, field: string) => {
    const i = dirty.findIndex((l) => l.id === lineId);
    return i >= 0 ? errors[`lines.${i}.${field}`] : undefined;
  };

  return (
    <div className="space-y-6">
      <Card className="overflow-hidden">
        <CardHeader
          title={t("stocktakes.counted")}
          description={dirty.length > 0 ? <span className="font-medium text-warning">{t("stocktakes.unsaved")}</span> : undefined}
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("stock.search")} aria-label={t("stock.search")} className="h-8 w-48" dir="auto" />
              <Select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)} aria-label={t("stocktakes.filter")} className="h-8 w-44">
                <option value="all">{t("stocktakes.allLines")}</option>
                <option value="diff">{t("stocktakes.onlyDifferences")}</option>
                <option value="uncounted">{t("stocktakes.onlyUncounted")}</option>
              </Select>
            </div>
          }
        />
        {lines.length === 0 ? (
          <Alert className="m-5">{t("stocktakes.noLines")}</Alert>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-sm">
              <thead className={tableHead}>
                <tr>
                  <th className={th}>{t("stock.fields.product")}</th>
                  <th className={th}>{t("stock.fields.bin")}</th>
                  <th className={thEnd}>{t("stocktakes.system")}</th>
                  <th className={th}>{t("stocktakes.counted")}</th>
                  <th className={thEnd}>{t("stocktakes.difference")}</th>
                  <th className={th}>{t("stocktakes.explain")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {visible.map((l) => {
                  const d = drafts[l.id] ?? draftOf(l);
                  const c = counted(l);
                  const diff = c === null ? null : Math.round((c - l.systemQuantity) * 1000) / 1000;
                  const found = parseSerials(d.serials);
                  const missing = l.product.trackSerials ? l.systemSerials.filter((s) => !found.includes(s)) : [];
                  const extra = l.product.trackSerials ? found.filter((s) => !l.systemSerials.includes(s)) : [];
                  const differs = (diff !== null && diff !== 0) || missing.length > 0 || extra.length > 0;
                  const set = (patch: Partial<Draft>) => setDrafts((all) => ({ ...all, [l.id]: { ...d, ...patch } }));
                  return (
                    <tr key={l.id} className={cn("align-top", differs && "bg-warning-soft/40")}>
                      <td className="px-4 py-2.5">
                        <bdi className="font-mono font-semibold">{l.product.sku}</bdi> <span>{nameOf(l.product, t)}</span>
                        {l.product.trackSerials && l.systemSerials.length > 0 && (
                          <span className="mt-1 block font-mono text-xs text-fg-subtle" dir="ltr">
                            {t("stocktakes.expectedSerials", { list: l.systemSerials.join(", ") })}
                          </span>
                        )}
                        {l.countedBy && <span className="mt-0.5 block text-xs text-fg-subtle">{t("stocktakes.countedBy", { name: l.countedBy.name })}</span>}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-fg-muted">{l.bin ?? "—"}</td>
                      <td className="px-4 py-2.5 text-end tabular-nums">
                        {formatQuantity(l.systemQuantity, L)} <span className="text-xs text-fg-subtle">{l.product.unit.code}</span>
                      </td>
                      <td className="px-4 py-2.5">
                        {!can.count ? (
                          <span className="tabular-nums">{c === null ? "—" : formatQuantity(c, L)}</span>
                        ) : l.product.trackSerials ? (
                          <Textarea
                            value={d.serials}
                            onChange={(e) => set({ serials: e.target.value, counted: "" })}
                            rows={Math.min(6, Math.max(2, l.systemSerials.length))}
                            aria-label={`${t("stocktakes.countedSerials")} ${l.product.sku}`}
                            placeholder={t("stocktakes.countedSerials")}
                            className="w-56 font-mono text-xs"
                            dir="ltr"
                          />
                        ) : (
                          <Input
                            value={d.counted}
                            onChange={(e) => set({ counted: e.target.value })}
                            inputMode={l.product.unit.allowsFraction ? "decimal" : "numeric"}
                            aria-label={`${t("stocktakes.counted")} ${l.product.sku}`}
                            aria-invalid={errFor(l.id, "countedQuantity") ? true : undefined}
                            className="h-9 w-28"
                            dir="ltr"
                          />
                        )}
                        {can.count && l.product.trackSerials && !d.serials.trim() && (
                          <Button size="sm" variant="ghost" className="mt-1" onClick={() => set({ counted: "0", serials: "" })} aria-pressed={d.counted === "0"}>
                            {d.counted === "0" ? `✓ ${t("stocktakes.noneFound")}` : t("stocktakes.noneFound")}
                          </Button>
                        )}
                        {(errFor(l.id, "countedQuantity") || errFor(l.id, "countedSerials")) && (
                          <p className="mt-1 text-xs font-medium text-danger" role="alert">
                            {t.msg(errFor(l.id, "countedQuantity") ?? errFor(l.id, "countedSerials"))}
                          </p>
                        )}
                        {missing.length > 0 && c !== null && (
                          <p className="mt-1 font-mono text-xs text-danger" dir="ltr">
                            {t("stocktakes.missingSerials", { list: missing.join(", ") })}
                          </p>
                        )}
                        {extra.length > 0 && (
                          <p className="mt-1 font-mono text-xs text-warning" dir="ltr">
                            {t("stocktakes.extraSerials", { list: extra.join(", ") })}
                          </p>
                        )}
                      </td>
                      <td className={cn("px-4 py-2.5 text-end font-medium tabular-nums", diff !== null && diff > 0 && "text-success", diff !== null && diff < 0 && "text-danger")}>
                        {diff === null ? "—" : diff > 0 ? `+${formatQuantity(diff, L)}` : formatQuantity(diff, L)}
                      </td>
                      <td className="px-4 py-2.5">
                        {can.count ? (
                          <Input
                            value={d.reason}
                            onChange={(e) => set({ reason: e.target.value })}
                            placeholder={differs ? t("stocktakes.explainPlaceholder") : ""}
                            aria-label={`${t("stocktakes.explain")} ${l.product.sku}`}
                            maxLength={300}
                            className="h-9 w-56"
                            dir="auto"
                          />
                        ) : (
                          <span className="text-fg-muted" dir="auto">
                            {l.reason ?? "—"}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {can.count && (
        <Card>
          <CardHeader title={t("stocktakes.addProduct")} />
          <div className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-[1fr_12rem_auto] sm:items-end">
            {adding.product ? (
              <div className="flex items-center gap-2 text-sm">
                <bdi className="font-mono font-semibold">{adding.product.sku}</bdi> {nameOf(adding.product, t)}
                <Button size="sm" variant="ghost" onClick={() => setAdding({ ...adding, product: null })}>
                  {t("stock.form.change")}
                </Button>
              </div>
            ) : (
              <ProductPicker label={t("stocktakes.addProduct")} warehouseId={warehouseId} error={errors.productId} onPick={(p) => setAdding({ ...adding, product: p })} />
            )}
            {bins.length > 0 ? (
              <Field label={t("stock.fields.bin")} error={errors.binId}>
                {(p) => (
                  <Select {...p} value={adding.binId} onChange={(e) => setAdding({ ...adding, binId: e.target.value })}>
                    <option value="">{t("stock.noBin")}</option>
                    {bins.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.code}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            ) : (
              <span />
            )}
            <Button
              variant="outline"
              disabled={!adding.product}
              loading={busy}
              onClick={async () => {
                const ok = await act("lines", { productId: adding.product?.id, binId: adding.binId || null }, t("stocktakes.added"));
                if (ok) setAdding({ product: null, binId: "" });
              }}
            >
              {t("stocktakes.add")}
            </Button>
          </div>
        </Card>
      )}

      {(can.count || can.submit || can.decide || can.cancel) && (
        <div className="flex flex-wrap justify-end gap-2">
          {errors._form && (
            <p className="me-auto text-sm font-medium text-danger" role="alert">
              {t.msg(errors._form)}
            </p>
          )}
          {can.cancel && (
            <ConfirmButton
              variant="ghost"
              label={t("stocktakes.cancel")}
              title={t("stocktakes.cancelTitle", { number })}
              text={t("stocktakes.cancelText")}
              confirmLabel={t("stocktakes.cancel")}
              reason={{ label: t("common.noteOptional") }}
              busy={busy}
              onConfirm={(note) => act("cancel", { note }, t("stocktakes.cancelledMsg"))}
            />
          )}
          {can.count && (
            <Button variant="outline" loading={busy} disabled={!dirty.length} onClick={() => void saveCounts()}>
              {t("stocktakes.saveCounts")}
            </Button>
          )}
          {can.submit && (
            <ConfirmButton
              label={t("stocktakes.submit")}
              title={t("stocktakes.submitTitle", { number })}
              text={t("stocktakes.submitText")}
              confirmLabel={t("stocktakes.submit")}
              busy={busy}
              error={errors._form}
              onConfirm={async () => (await saveCounts()) && act("submit", {}, t("stocktakes.submitted"))}
            />
          )}
          {can.decide && (
            <>
              <ConfirmButton
                variant="danger"
                label={t("stocktakes.reject")}
                title={t("stocktakes.rejectTitle", { number })}
                text={t("stocktakes.rejectText")}
                confirmLabel={t("stocktakes.reject")}
                reason={{ label: t("stocktakes.rejectNote"), required: true }}
                busy={busy}
                error={errors.note}
                onConfirm={(note) => act("reject", { note }, t("stocktakes.rejected"))}
              />
              <ConfirmButton
                label={t("stocktakes.approve")}
                title={t("stocktakes.approveTitle", { number })}
                text={t("stocktakes.approveText")}
                confirmLabel={t("stocktakes.approve")}
                reason={{ label: t("common.noteOptional") }}
                busy={busy}
                error={errors._form}
                onConfirm={(note) => act("approve", { note }, t("stocktakes.approved"))}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}
