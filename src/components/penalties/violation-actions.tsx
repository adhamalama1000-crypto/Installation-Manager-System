"use client";

import { useState } from "react";
import { Ban, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { useAction } from "@/components/erp/use-action";
import { useT } from "@/i18n/client";
import { api } from "@/lib/api-client";
import type { ViolationKindValue } from "@/lib/penalties";

type Target = { id: string; number: string; kind: ViolationKindValue; amount: number; can: { decide: boolean; cancel: boolean } };

/** Approve / reject a proposed violation, or cancel one (with the reason). The server checks every right. */
export function ViolationActions({ v, size = "sm" }: { v: Target; size?: "sm" | "md" }) {
  const t = useT();
  const [open, setOpen] = useState<"APPROVED" | "REJECTED" | "CANCEL" | null>(null);
  const [kind, setKind] = useState<ViolationKindValue>(v.kind);
  const [amount, setAmount] = useState(v.amount ? String(v.amount) : "");
  const [note, setNote] = useState("");
  const { busy, errors, run } = useAction();
  if (!v.can.decide && !v.can.cancel) return null;

  function show(d: typeof open) {
    setKind(v.kind);
    setAmount(v.amount ? String(v.amount) : "");
    setNote("");
    setOpen(d);
  }

  async function submit() {
    const r =
      open === "CANCEL"
        ? await run(() => api(`/api/penalties/${v.id}/cancel`, { method: "POST", body: { reason: note } }), () => t("penalties.cancelled"))
        : await run(
            () => api(`/api/penalties/${v.id}/decision`, { method: "POST", body: open === "APPROVED" ? { decision: "APPROVED", kind, amount: kind === "DEDUCTION" ? amount : undefined, note } : { decision: "REJECTED", note } }),
            () => t(open === "APPROVED" ? "penalties.approved" : "penalties.rejected"),
          );
    if (r) setOpen(null);
  }

  const title = open === "APPROVED" ? t("penalties.approveTitle", { number: v.number }) : open === "REJECTED" ? t("penalties.rejectTitle", { number: v.number }) : t("penalties.cancelTitle", { number: v.number });
  const text = open === "APPROVED" ? t("penalties.approveText") : open === "REJECTED" ? t("penalties.rejectText") : t("penalties.cancelText");

  return (
    <div className="flex flex-wrap justify-end gap-1.5">
      {v.can.decide && (
        <>
          <Button size={size} onClick={() => show("APPROVED")} aria-label={`${t("penalties.approve")} ${v.number}`}>
            <Check className="h-4 w-4" /> {t("penalties.approve")}
          </Button>
          <Button size={size} variant="outline" onClick={() => show("REJECTED")} aria-label={`${t("penalties.reject")} ${v.number}`}>
            <X className="h-4 w-4" /> {t("penalties.reject")}
          </Button>
        </>
      )}
      {v.can.cancel && (
        <Button size={size} variant="ghost" onClick={() => show("CANCEL")} aria-label={`${t("penalties.cancel")} ${v.number}`}>
          <Ban className="h-4 w-4" /> {t("penalties.cancel")}
        </Button>
      )}
      <Dialog
        open={open !== null}
        onClose={() => setOpen(null)}
        title={title}
        description={text}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(null)} disabled={busy}>
              {t("common.close")}
            </Button>
            <Button variant={open === "APPROVED" ? "primary" : "danger"} loading={busy} onClick={() => void submit()}>
              {open === "APPROVED" ? t("penalties.approve") : open === "REJECTED" ? t("penalties.reject") : t("penalties.cancel")}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {errors._form && <p className="text-sm text-danger">{t.msg(errors._form)}</p>}
          {open === "APPROVED" && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={t("penalties.kind")}>
                {(p) => (
                  <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as ViolationKindValue)}>
                    <option value="WARNING">{t("penalties.kinds.WARNING")}</option>
                    <option value="DEDUCTION">{t("penalties.kinds.DEDUCTION")}</option>
                  </Select>
                )}
              </Field>
              {kind === "DEDUCTION" && (
                <Field label={t("penalties.amount")} required error={errors.amount}>
                  {(p) => <Input {...p} inputMode="decimal" dir="ltr" value={amount} onChange={(e) => setAmount(e.target.value)} />}
                </Field>
              )}
            </div>
          )}
          <Field label={open === "APPROVED" ? t("penalties.note") : t("penalties.reason")} required={open !== "APPROVED"} error={open === "CANCEL" ? errors.reason : errors.note}>
            {(p) => <Textarea {...p} rows={3} maxLength={1000} dir="auto" value={note} onChange={(e) => setNote(e.target.value)} />}
          </Field>
        </div>
      </Dialog>
    </div>
  );
}
