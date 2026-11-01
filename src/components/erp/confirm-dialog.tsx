"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Textarea } from "@/components/ui/field";
import { useT } from "@/i18n/client";

/**
 * A button that asks before doing something that cannot be taken back (post, reverse, approve).
 * With `reason`, the dialog asks for a text that is passed to `onConfirm`.
 */
export function ConfirmButton({
  label,
  title,
  text,
  confirmLabel,
  onConfirm,
  variant = "primary",
  size = "md",
  reason,
  busy,
  error,
}: {
  label: React.ReactNode;
  title: string;
  text: string;
  confirmLabel: string;
  onConfirm: (reason: string) => Promise<boolean>;
  variant?: "primary" | "secondary" | "outline" | "danger" | "ghost";
  size?: "sm" | "md";
  reason?: { label: string; required?: boolean; placeholder?: string };
  busy?: boolean;
  error?: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const missing = !!reason?.required && !value.trim();
  return (
    <>
      <Button variant={variant} size={size} onClick={() => setOpen(true)}>
        {label}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={title}
        description={text}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant={variant === "danger" ? "danger" : "primary"}
              loading={busy}
              disabled={missing}
              onClick={async () => {
                if (await onConfirm(value.trim())) {
                  setOpen(false);
                  setValue("");
                }
              }}
            >
              {confirmLabel}
            </Button>
          </>
        }
      >
        {reason ? (
          <Field label={reason.label} required={reason.required} error={error}>
            {(p) => <Textarea {...p} rows={3} maxLength={500} value={value} placeholder={reason.placeholder} onChange={(e) => setValue(e.target.value)} />}
          </Field>
        ) : error ? (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        ) : null}
      </Dialog>
    </>
  );
}
