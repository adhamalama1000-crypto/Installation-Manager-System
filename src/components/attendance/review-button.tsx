"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Textarea } from "@/components/ui/field";
import { useAction } from "@/components/erp/use-action";
import { useT } from "@/i18n/client";
import { api } from "@/lib/api-client";

/** Accept or reject a flagged clock-in / out (a rejection needs a note). */
export function ReviewButton({ checkInId, label }: { checkInId: string; label: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const { busy, errors, run } = useAction();
  async function decide(decision: "ACCEPTED" | "REJECTED") {
    const r = await run(() => api(`/api/attendance/review/${checkInId}`, { method: "POST", body: { decision, note } }), () => t("clock.reviewed"));
    if (r) setOpen(false);
  }
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        {t("clock.review")}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={`${t("clock.review")} · ${label}`}
        size="sm"
        footer={
          <>
            <Button variant="outline" loading={busy} onClick={() => void decide("REJECTED")}>
              {t("clock.reject")}
            </Button>
            <Button loading={busy} onClick={() => void decide("ACCEPTED")}>
              {t("clock.accept")}
            </Button>
          </>
        }
      >
        <Field label={t("clock.reviewNote")} error={errors.note}>
          {(p) => <Textarea {...p} value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={500} dir="auto" />}
        </Field>
      </Dialog>
    </>
  );
}
