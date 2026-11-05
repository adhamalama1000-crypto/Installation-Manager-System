"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Textarea } from "@/components/ui/field";
import { useAction } from "@/components/erp/use-action";
import { useT } from "@/i18n/client";
import { api } from "@/lib/api-client";

/** Confirm a draft, cancel a draft, or cancel a confirmed sale (with a reason). */
export function SaleActions({ id, version, can, warehouseLabel }: { id: string; version: number; can: { confirm: boolean; cancelDraft: boolean; void: boolean }; warehouseLabel: string }) {
  const t = useT();
  const router = useRouter();
  const { busy, errors, run } = useAction();
  const [open, setOpen] = useState<"confirm" | "void" | null>(null);
  const [reason, setReason] = useState("");
  const done = (ok: unknown) => {
    if (ok) {
      setOpen(null);
      router.refresh();
    }
  };
  return (
    <div className="flex flex-wrap gap-2">
      {can.cancelDraft && (
        <Button variant="ghost" loading={busy} onClick={async () => done(await run(() => api(`/api/sales/${id}/cancel`, { method: "POST", body: { version } }), () => t("sales.cancelled")))}>
          {t("sales.cancelDraft")}
        </Button>
      )}
      {can.void && (
        <Button variant="outline" onClick={() => setOpen("void")}>
          {t("sales.void")}
        </Button>
      )}
      {can.confirm && <Button onClick={() => setOpen("confirm")}>{t("sales.confirm")}</Button>}
      <Dialog
        open={open === "confirm"}
        onClose={() => setOpen(null)}
        title={t("sales.confirmTitle")}
        description={t("sales.confirmText", { warehouse: warehouseLabel })}
        size="sm"
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(null)}>
              {t("common.cancel")}
            </Button>
            <Button loading={busy} onClick={async () => done(await run(() => api(`/api/sales/${id}/confirm`, { method: "POST", body: {} }), () => t("sales.confirmed")))}>
              {t("sales.confirm")}
            </Button>
          </>
        }
      >
        {errors._form && <p className="text-sm text-danger">{t.msg(errors._form)}</p>}
      </Dialog>
      <Dialog
        open={open === "void"}
        onClose={() => setOpen(null)}
        title={t("sales.voidTitle")}
        description={t("sales.voidText")}
        size="sm"
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(null)}>
              {t("common.cancel")}
            </Button>
            <Button variant="danger" loading={busy} onClick={async () => done(await run(() => api(`/api/sales/${id}/cancel`, { method: "POST", body: { reason, version } }), () => t("sales.cancelled")))}>
              {t("sales.void")}
            </Button>
          </>
        }
      >
        <Field label={t("stock.fields.reason")} required error={errors.reason ?? errors._form}>
          {(p) => <Textarea {...p} value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} dir="auto" />}
        </Field>
      </Dialog>
    </div>
  );
}
