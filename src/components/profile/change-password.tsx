"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { useI18n } from "@/i18n/client";
import { api, ApiError } from "@/lib/api-client";

export function ChangePasswordForm() {
  const { t } = useI18n();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (next !== confirm) {
      setErrors({ confirm: t("v.passwordsDiffer") });
      return;
    }
    setSaving(true);
    setErrors({});
    try {
      await api("/api/me/password", { method: "POST", body: { currentPassword: current, newPassword: next } });
      toast.success(t("prof.passwordChanged"));
      setCurrent("");
      setNext("");
      setConfirm("");
    } catch (err) {
      setErrors((err as ApiError).fieldErrors ?? {});
      toast.error((err as ApiError).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="max-w-md space-y-4" noValidate>
      <Field label={t("prof.currentPassword")} error={errors.currentPassword}>
        {(p) => <Input {...p} type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />}
      </Field>
      <Field label={t("prof.newPassword")} error={errors.newPassword} hint={t("prof.newPasswordHint")}>
        {(p) => <Input {...p} type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />}
      </Field>
      <Field label={t("prof.confirmPassword")} error={errors.confirm}>
        {(p) => <Input {...p} type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />}
      </Field>
      <Button type="submit" loading={saving}>
        {t("prof.changePassword")}
      </Button>
    </form>
  );
}
