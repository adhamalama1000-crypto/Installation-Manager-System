"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useT } from "@/i18n/client";
import { ApiError } from "@/lib/api-client";

/**
 * Runs a server call with the shared feedback: busy state, a toast with the result, field errors
 * kept for the form, and a refresh of the server-rendered page.
 */
export function useAction() {
  const t = useT();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  async function run<R>(fn: () => Promise<R>, success: (r: R) => string | null, opts: { refresh?: boolean } = {}): Promise<R | null> {
    setBusy(true);
    setErrors({});
    try {
      const r = await fn();
      const text = success(r);
      if (text) toast.success(text);
      if (opts.refresh !== false) router.refresh();
      return r;
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError(t("common.couldNotSave"), 0, "UNKNOWN");
      setErrors(err.fieldErrors);
      toast.error(err.message);
      return null;
    } finally {
      setBusy(false);
    }
  }
  return { busy, errors, setErrors, run };
}

/** A fresh id that makes a create request safe to repeat (double click, retry). */
export function requestId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
