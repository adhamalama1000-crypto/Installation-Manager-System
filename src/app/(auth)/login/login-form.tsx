"use client";

import { useState } from "react";
import { Eye, EyeOff, LogIn } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { Alert } from "@/components/ui/misc";
import { useI18n } from "@/i18n/client";
import { api, ApiError } from "@/lib/api-client";

export function LoginForm({ next }: { next: string }) {
  const { t } = useI18n();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!email.trim() || !password) {
      setError(t("auth.enterBoth"));
      return;
    }
    setLoading(true);
    try {
      await api("/api/auth/login", { method: "POST", body: { email, password } });
      window.location.href = next;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("auth.failed"));
      setLoading(false);
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">{t("auth.welcome")}</h1>
      <p className="mt-1 text-sm text-fg-muted">{t("auth.signInTo", { app: t("app.name") })}</p>
      <form onSubmit={submit} className="mt-8 space-y-5" noValidate>
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label={t("common.email")}>
          {(p) => <Input {...p} type="email" dir="ltr" autoComplete="username" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t("auth.emailPlaceholder")} />}
        </Field>
        <Field label={t("auth.password")}>
          {(p) => (
            <div className="relative">
              <Input {...p} type={show ? "text" : "password"} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className="pe-10" />
              <button
                type="button"
                onClick={() => setShow((s) => !s)}
                className="absolute inset-y-0 end-0 flex w-10 items-center justify-center text-fg-subtle hover:text-fg"
                aria-label={show ? t("auth.hidePassword") : t("auth.showPassword")}
              >
                {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          )}
        </Field>
        <Button type="submit" size="lg" className="w-full" loading={loading}>
          {!loading && <LogIn className="h-4 w-4 rtl:-scale-x-100" />} {t("auth.signIn")}
        </Button>
        <p className="text-center text-xs text-fg-subtle">{t("auth.forgot")}</p>
      </form>
    </div>
  );
}
