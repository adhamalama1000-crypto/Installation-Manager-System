"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { CustomerConfirmation } from "@prisma/client";
import { useI18n } from "@/i18n/client";
import { api, ApiError } from "@/lib/api-client";
import { CONFIRMATIONS } from "@/lib/constants";
import { cn } from "@/lib/utils";

const TONE: Record<CustomerConfirmation, string> = {
  PENDING: "text-warning",
  CONFIRMED: "text-success",
  RESCHEDULE_REQUESTED: "text-danger",
  UNREACHABLE: "text-danger",
};

/** Customer confirmation of the booked time; a select for users who may manage the appointment. */
export function ConfirmationControl({ id, version, value, canManage }: { id: string; version: number; value: CustomerConfirmation; canManage: boolean }) {
  const { t, label } = useI18n();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  if (!canManage) return <span className={cn("font-medium", TONE[value])}>{label("confirmation", value)}</span>;
  async function change(next: CustomerConfirmation) {
    setBusy(true);
    try {
      await api(`/api/appointments/${id}/confirmation`, { method: "POST", body: { confirmation: next, version } });
      toast.success(label("confirmation", next));
      router.refresh();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : t("act.couldNotSave"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <select
      aria-label={t("conf.label")}
      value={value}
      disabled={busy}
      onChange={(e) => change(e.target.value as CustomerConfirmation)}
      className={cn("h-9 w-full rounded-lg border border-line-strong bg-surface px-2 text-sm font-medium", TONE[value])}
    >
      {CONFIRMATIONS.map((c) => (
        <option key={c} value={c}>
          {label("confirmation", c)}
        </option>
      ))}
    </select>
  );
}
