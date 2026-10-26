"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { Alert } from "@/components/ui/misc";
import { useT } from "@/i18n/client";
import { api, ApiError } from "@/lib/api-client";
import { passwordSchema } from "@/lib/validation";

export function SetPasswordForm({ token }: { token: string }) {
  const t = useT();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const next: Record<string, string> = {};
    const check = passwordSchema.safeParse(password);
    if (!check.success) next.password = check.error.issues[0]!.message;
    if (password !== confirm) next.confirm = t("auth.passwordsDontMatch");
    setErrors(next);
    if (Object.keys(next).length) return;
    setLoading(true);
    try {
      await api("/api/auth/set-password", { method: "POST", body: { token, password } });
      setDone(true);
    } catch (err) {
      const e2 = err as ApiError;
      setErrors({ _form: e2.fieldErrors?.token ?? e2.fieldErrors?.password ?? e2.message });
    } finally {
      setLoading(false);
    }
  }

  if (done) {
    return (
      <div className="space-y-6">
        <Alert tone="success" title={t("auth.passwordSaved")}>{t("auth.passwordSavedText")}</Alert>
        <Link href="/login" className="block text-center text-sm font-medium text-brand-text hover:underline">
          {t("auth.goToSignIn")}
        </Link>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">{t("auth.setYourPassword")}</h1>
      <p className="mt-1 text-sm text-fg-muted">{t("auth.passwordRule")}</p>
      <form onSubmit={submit} className="mt-8 space-y-5" noValidate>
        {errors._form && <Alert tone="danger">{t.msg(errors._form)}</Alert>}
        <Field label={t("auth.newPassword")} error={errors.password} required>
          {(p) => <Input {...p} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
        </Field>
        <Field label={t("auth.confirmPassword")} error={errors.confirm} required>
          {(p) => <Input {...p} type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />}
        </Field>
        <Button type="submit" size="lg" className="w-full" loading={loading}>
          {t("auth.savePassword")}
        </Button>
      </form>
    </div>
  );
}
