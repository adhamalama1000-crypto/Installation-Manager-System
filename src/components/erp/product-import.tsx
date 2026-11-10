"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Download, FileSpreadsheet, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/field";
import { Alert, Badge } from "@/components/ui/misc";
import { useT } from "@/i18n/client";
import { ApiError } from "@/lib/api-client";
import { PRODUCT_COLUMNS, STOCK_COLUMNS, MAX_IMPORT_BYTES } from "@/lib/product-import";
import { cn } from "@/lib/utils";
import { tableHead, th } from "./labels";

type RowAction = "create" | "update" | "skip" | "error";
type Result = {
  committed: boolean;
  rows: { sheet: "products" | "stock"; row: number; sku: string | null; name: string | null; action: RowAction; messages: { field: string | null; message: string }[] }[];
  counts: Record<RowAction, number>;
  openingDocuments: { id: string; number: string; warehouse: string }[];
};

const tone: Record<RowAction, string> = {
  create: "border-success/40 bg-success-soft text-fg",
  update: "border-brand/40 bg-brand-soft text-fg",
  skip: "",
  error: "border-danger/40 bg-danger-soft text-danger",
};

/** Upload an Excel file, see what every row would do, then import (or correct and upload again). */
export function ProductImport({ canOpenStock }: { canOpenStock: boolean }) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [opts, setOpts] = useState({ update: false, createMissing: true, skipInvalid: false });
  const [busy, setBusy] = useState<"preview" | "commit" | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [onlyErrors, setOnlyErrors] = useState(false);

  const label = (sheet: "products" | "stock", key: string | null) => {
    if (!key) return "";
    const c = (sheet === "stock" ? STOCK_COLUMNS : PRODUCT_COLUMNS).find((x) => x.key === key);
    return c ? (t.locale === "ar" ? c.ar : c.en) : key;
  };

  async function send(mode: "preview" | "commit") {
    if (!file) {
      toast.error(t("productImport.errors.file"));
      return;
    }
    if (file.size > MAX_IMPORT_BYTES) {
      toast.error(t("productImport.errors.tooLarge", { mb: MAX_IMPORT_BYTES / 1024 / 1024 }));
      return;
    }
    setBusy(mode);
    try {
      const q = new URLSearchParams({ mode, update: opts.update ? "1" : "0", createMissing: opts.createMissing ? "1" : "0", skipInvalid: opts.skipInvalid ? "1" : "0" });
      const res = await fetch(`/api/products/import?${q}`, { method: "POST", headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }, body: file, credentials: "same-origin" });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new ApiError(data?.error?.message ?? t("common.couldNotSave"), res.status, data?.error?.code ?? "UNKNOWN", data?.error?.fieldErrors);
      const r = data as Result;
      setResult(r);
      if (mode === "commit") {
        if (r.committed) toast.success(t("productImport.done", { created: r.counts.create, updated: r.counts.update, skipped: r.counts.skip, failed: r.counts.error }));
        else toast.error(t("productImport.errors.hasErrors", { count: r.counts.error }));
      }
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : t("errors.network"));
    } finally {
      setBusy(null);
    }
  }

  const rows = useMemo(() => (result ? result.rows.filter((r) => !onlyErrors || r.action === "error") : []), [result, onlyErrors]);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader title={t("productImport.template")} description={t("productImport.templateHint")} />
        <div className="flex flex-wrap gap-3 p-5">
          <a href="/api/products/import/template" className="inline-flex h-10 items-center gap-2 rounded-lg border border-line-strong px-4 text-sm font-medium hover:bg-surface-muted" download>
            <FileSpreadsheet className="h-4 w-4" /> {t("productImport.template")}
          </a>
          <a href="/api/products/export" className="inline-flex h-10 items-center gap-2 rounded-lg border border-line-strong px-4 text-sm font-medium hover:bg-surface-muted" download>
            <Download className="h-4 w-4" /> {t("productImport.export")}
          </a>
          <p className="basis-full text-xs text-fg-subtle">{t("productImport.exportHint")}</p>
        </div>
      </Card>

      <Card>
        <CardHeader title={t("productImport.title")} description={t("productImport.text")} />
        <div className="space-y-4 p-5">
          <div className="flex flex-wrap items-center gap-3">
            <input
              ref={input}
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              aria-label={t("productImport.upload")}
              className="block max-w-full text-sm file:me-3 file:rounded-lg file:border file:border-line-strong file:bg-surface file:px-3 file:py-2 file:text-sm"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setResult(null);
              }}
            />
          </div>
          <div className="space-y-1">
            <Checkbox label={t("productImport.updateExisting")} description={t("productImport.updateExistingHint")} checked={opts.update} onChange={(e) => setOpts({ ...opts, update: e.target.checked })} />
            <Checkbox label={t("productImport.createMissing")} checked={opts.createMissing} onChange={(e) => setOpts({ ...opts, createMissing: e.target.checked })} />
            <Checkbox label={t("productImport.skipInvalid")} description={t("productImport.skipInvalidHint")} checked={opts.skipInvalid} onChange={(e) => setOpts({ ...opts, skipInvalid: e.target.checked })} />
          </div>
          {!canOpenStock && <p className="text-xs text-fg-subtle">{t("productImport.errors.openingNeedsApproval")}</p>}
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" loading={busy === "preview"} disabled={!file || !!busy} onClick={() => void send("preview")}>
              {t("productImport.preview")}
            </Button>
            <Button type="button" loading={busy === "commit"} disabled={!file || !!busy || !result || (result.counts.error > 0 && !opts.skipInvalid) || (result.committed && !!file)} onClick={() => void send("commit")}>
              <Upload className="h-4 w-4" /> {t("productImport.importNow")}
            </Button>
          </div>
        </div>
      </Card>

      {result && (
        <Card className="overflow-hidden">
          <CardHeader
            title={result.committed ? t("productImport.done", { created: result.counts.create, updated: result.counts.update, skipped: result.counts.skip, failed: result.counts.error }) : t("productImport.summary", { create: result.counts.create, update: result.counts.update, skip: result.counts.skip, error: result.counts.error })}
            actions={<Checkbox label={t("productImport.onlyErrors")} checked={onlyErrors} onChange={(e) => setOnlyErrors(e.target.checked)} />}
          />
          {result.committed && result.openingDocuments.length > 0 && (
            <Alert tone="info" className="mx-5 mt-4">
              {t("productImport.openingDrafts", { list: "" })}{" "}
              {result.openingDocuments.map((d, i) => (
                <span key={d.id}>
                  {i > 0 && ", "}
                  <Link href={`/stock/documents/${d.id}`} className="font-mono font-semibold text-brand-text hover:underline">
                    {d.number}
                  </Link>{" "}
                  ({d.warehouse})
                </span>
              ))}
            </Alert>
          )}
          {!result.committed && result.counts.error > 0 && !opts.skipInvalid && <Alert tone="danger" className="mx-5 mt-4">{t("productImport.errors.hasErrors", { count: result.counts.error })}</Alert>}
          {result.rows.length === 0 ? (
            <p className="p-5 text-sm text-fg-muted">{t("productImport.noRows")}</p>
          ) : (
            <div className="max-h-[32rem] overflow-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead className={cn(tableHead, "sticky top-0")}>
                  <tr>
                    <th className={th}>{t("productImport.sheet")}</th>
                    <th className={th}>{t("productImport.row")}</th>
                    <th className={th}>{t("catalog.products.sku")}</th>
                    <th className={th}>{t("stock.fields.product")}</th>
                    <th className={th}>{t("productImport.action")}</th>
                    <th className={th}>{t("productImport.problems")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {rows.map((r) => (
                    <tr key={`${r.sheet}-${r.row}`} className={r.action === "error" ? "bg-danger-soft/30" : ""}>
                      <td className="px-4 py-2 text-fg-muted">{r.sheet === "stock" ? t("productImport.sheetStock") : t("productImport.sheetProducts")}</td>
                      <td className="px-4 py-2 tabular-nums">{r.row}</td>
                      <td className="px-4 py-2 font-mono text-xs">{r.sku ?? "—"}</td>
                      <td className="px-4 py-2" dir="auto">
                        {r.name ?? "—"}
                      </td>
                      <td className="px-4 py-2">
                        <Badge className={tone[r.action]}>{t(`productImport.actions.${r.action}`)}</Badge>
                      </td>
                      <td className="px-4 py-2 text-xs">
                        {r.messages.map((m, i) => (
                          <p key={i} className={r.action === "error" ? "text-danger" : "text-fg-muted"}>
                            {m.field && <span className="font-semibold">{label(r.sheet, m.field)}: </span>}
                            {t.msg(m.message)}
                          </p>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
