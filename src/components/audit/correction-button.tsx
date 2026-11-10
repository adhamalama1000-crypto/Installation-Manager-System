"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Textarea } from "@/components/ui/field";
import { useAction } from "@/components/erp/use-action";
import { useT } from "@/i18n/client";
import { api } from "@/lib/api-client";

/** Records an administrative correction of an audit entry as a NEW entry (history is never edited). */
export function CorrectionButton({ auditId }: { auditId: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const { busy, errors, run } = useAction();
  async function save() {
    const r = await run(() => api(`/api/audit/${auditId}/correction`, { method: "POST", body: { reason, note } }), () => t("auditLog.corrected"));
    if (r) {
      setOpen(false);
      setReason("");
      setNote("");
    }
  }
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        {t("auditLog.correction")}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={t("auditLog.correctionTitle")}
        description={t("auditLog.correctionText")}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              {t("common.cancel")}
            </Button>
            <Button loading={busy} onClick={() => void save()}>
              {t("common.save")}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label={t("auditLog.correctionNote")} required error={errors.note}>
            {(p) => <Textarea {...p} rows={3} maxLength={2000} dir="auto" value={note} onChange={(e) => setNote(e.target.value)} />}
          </Field>
          <Field label={t("auditLog.reason")} required error={errors.reason}>
            {(p) => <Textarea {...p} rows={2} maxLength={1000} dir="auto" value={reason} onChange={(e) => setReason(e.target.value)} />}
          </Field>
        </div>
      </Dialog>
    </>
  );
}
