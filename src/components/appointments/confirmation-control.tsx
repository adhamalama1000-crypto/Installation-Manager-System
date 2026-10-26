"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { CustomerConfirmation } from "@prisma/client";
import { api, ApiError } from "@/lib/api-client";
import { useT } from "@/i18n/client";
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
  const t = useT();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const label = (c: CustomerConfirmation) => t.dyn(`enums.confirmation.${c}`);
  if (!canManage) return <span className={cn("font-medium", TONE[value])}>{label(value)}</span>;
  async function change(next: CustomerConfirmation) {
    setBusy(true);
    try {
      await api(`/api/appointments/${id}/confirmation`, { method: "POST", body: { confirmation: next, version } });
      toast.success(label(next));
      router.refresh();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : t("common.couldNotSave"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <select
      aria-label={t("appointment.confirmation")}
      value={value}
      disabled={busy}
      onChange={(e) => change(e.target.value as CustomerConfirmation)}
      className={cn("h-9 w-full rounded-lg border border-line-strong bg-surface px-2 text-sm font-medium", TONE[value])}
    >
      {CONFIRMATIONS.map((c) => (
        <option key={c} value={c}>
          {label(c)}
        </option>
      ))}
    </select>
  );
}
