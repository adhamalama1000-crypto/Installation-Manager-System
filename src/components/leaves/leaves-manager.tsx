"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CalendarOff, Check, Plane, X } from "lucide-react";
import type { LeaveStatus } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { Alert, Badge, EmptyState } from "@/components/ui/misc";
import { useT } from "@/i18n/client";
import { msg } from "@/i18n/translator";
import { api, ApiError } from "@/lib/api-client";
import { LEAVE_TYPES } from "@/lib/constants";
import { dayRangeLabel, fmt } from "@/lib/time";
import type { LeaveClash, LeaveDTO } from "@/lib/types";
import { fieldErrorsFromZod, leaveInputSchema } from "@/lib/validation";
import { cn } from "@/lib/utils";

type Overview = { today: string; pending: LeaveDTO[]; upcoming: LeaveDTO[]; past: LeaveDTO[] };

const STATUS_TONE: Record<LeaveStatus, string> = {
  REQUESTED: "border-warning/40 bg-warning-soft text-fg",
  APPROVED: "border-success/40 bg-success-soft text-fg",
  REJECTED: "border-danger/40 bg-danger-soft text-fg",
  CANCELLED: "",
};

export function LeavesManager({
  overview,
  technicians,
  manage,
  timezone,
}: {
  overview: Overview;
  technicians: { id: string; name: string }[];
  manage: boolean;
  timezone: string;
}) {
  const t = useT();
  const [clashes, setClashes] = useState<{ name: string; items: LeaveClash[] } | null>(null);
  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
      <div className="min-w-0 space-y-6 xl:col-start-2 xl:row-start-1">
        <LeaveForm overview={overview} technicians={technicians} manage={manage} onClashes={setClashes} />
      </div>
      <div className="min-w-0 space-y-6 xl:col-start-1 xl:row-start-1">
        {clashes && clashes.items.length > 0 && (
          <Alert tone="warning" title={t("leaves.clashTitle", { name: clashes.name, count: clashes.items.length })}>
            <p>{t("leaves.clashText")}</p>
            <ul className="mt-2 space-y-1">
              {clashes.items.map((c) => (
                <li key={c.appointmentId}>
                  <Link href={`/appointments/${c.appointmentId}/edit`} prefetch={false} className="font-medium text-brand-text hover:underline" dir="ltr">
                    {c.code}
                  </Link>{" "}
                  · {c.customerName} · {fmt(c.startsAt, timezone, "EEE d MMM, HH:mm", t.locale)}
                </li>
              ))}
            </ul>
            <button type="button" className="mt-2 text-xs font-medium text-fg-muted hover:underline" onClick={() => setClashes(null)}>
              {t("common.dismiss")}
            </button>
          </Alert>
        )}
        <LeaveList
          title={manage ? t("leaves.pending") : t("leaves.myRequests")}
          description={manage ? t("leaves.pendingText") : t("leaves.myRequestsText")}
          items={overview.pending}
          manage={manage}
          empty={t("leaves.noPending")}
          onClashes={setClashes}
        />
        <LeaveList
          title={t("leaves.upcoming")}
          description={t("leaves.upcomingText")}
          items={overview.upcoming}
          manage={manage}
          empty={t("leaves.noUpcoming")}
          onClashes={setClashes}
        />
        <LeaveList title={t("appointment.history")} description={t("leaves.historyText")} items={overview.past} manage={manage} empty={t("leaves.nothingYet")} onClashes={setClashes} />
      </div>
    </div>
  );
}

function LeaveForm({
  overview,
  technicians,
  manage,
  onClashes,
}: {
  overview: Overview;
  technicians: { id: string; name: string }[];
  manage: boolean;
  onClashes: (c: { name: string; items: LeaveClash[] } | null) => void;
}) {
  const t = useT();
  const router = useRouter();
  const [values, setValues] = useState({ userId: "", type: "LEAVE", startDate: overview.today, endDate: overview.today, reason: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof values, v: string) => setValues((s) => ({ ...s, [k]: v, ...(k === "startDate" && s.endDate < v ? { endDate: v } : {}) }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const body = { ...values, userId: manage ? values.userId || null : null };
    const check = leaveInputSchema.safeParse(body);
    const fieldErrors = check.success ? {} : fieldErrorsFromZod(check.error);
    if (manage && !values.userId) fieldErrors.userId = msg("leaveErrors.chooseTechnician");
    if (Object.keys(fieldErrors).length) {
      setErrors(fieldErrors);
      return;
    }
    setBusy(true);
    setErrors({});
    try {
      const res = await api<{ leave: LeaveDTO; clashes: LeaveClash[] }>("/api/leaves", { method: "POST", body });
      toast.success(manage ? t("leaves.recorded") : t("leaves.requested"));
      onClashes(res.clashes.length ? { name: res.leave.user.name, items: res.clashes } : null);
      setValues((s) => ({ ...s, reason: "" }));
      router.refresh();
    } catch (err) {
      const apiErr = err instanceof ApiError ? err : new ApiError(t("common.couldNotSave"), 0, "UNKNOWN");
      setErrors(apiErr.fieldErrors);
      toast.error(apiErr.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title={manage ? t("leaves.add") : t("leaves.ask")}
        description={manage ? t("leaves.addText") : t("leaves.askText")}
        icon={<Plane className="h-4 w-4" />}
      />
      <form className="space-y-4 p-5" onSubmit={submit} noValidate>
        {manage && (
          <Field label={t("common.technician")} required error={errors.userId}>
            {(p) => (
              <Select {...p} value={values.userId} onChange={(e) => set("userId", e.target.value)}>
                <option value="">{t("common.choose")}</option>
                {technicians.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <Field label={t("common.type")} required error={errors.type}>
          {(p) => (
            <Select {...p} value={values.type} onChange={(e) => set("type", e.target.value)}>
              {LEAVE_TYPES.map((x) => (
                <option key={x} value={x}>
                  {t.dyn(`enums.leaveType.${x}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("historyFields.startDate")} required error={errors.startDate}>
            {(p) => <Input {...p} type="date" min={manage ? undefined : overview.today} value={values.startDate} onChange={(e) => set("startDate", e.target.value)} />}
          </Field>
          <Field label={t("historyFields.endDate")} required error={errors.endDate}>
            {(p) => <Input {...p} type="date" min={values.startDate} value={values.endDate} onChange={(e) => set("endDate", e.target.value)} />}
          </Field>
        </div>
        <Field label={t("common.reason")} error={errors.reason} hint={t("leaves.reasonHint")}>
          {(p) => <Textarea {...p} rows={2} maxLength={500} value={values.reason} onChange={(e) => set("reason", e.target.value)} />}
        </Field>
        {errors._form && <Alert tone="danger">{t.msg(errors._form)}</Alert>}
        <Button type="submit" className="w-full" loading={busy}>
          {manage ? t("leaves.add") : t("leaves.send")}
        </Button>
      </form>
    </Card>
  );
}

function LeaveList({
  title,
  description,
  items,
  manage,
  empty,
  onClashes,
}: {
  title: string;
  description: string;
  items: LeaveDTO[];
  manage: boolean;
  empty: string;
  onClashes: (c: { name: string; items: LeaveClash[] } | null) => void;
}) {
  return (
    <Card className="overflow-hidden">
      <CardHeader title={title} description={description} />
      {items.length === 0 ? (
        <EmptyState title={empty} icon={<CalendarOff className="h-6 w-6" />} />
      ) : (
        <ul className="divide-y divide-line">
          {items.map((l) => (
            <LeaveItem key={l.id} leave={l} manage={manage} onClashes={onClashes} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function LeaveItem({ leave: l, manage, onClashes }: { leave: LeaveDTO; manage: boolean; onClashes: (c: { name: string; items: LeaveClash[] } | null) => void }) {
  const t = useT();
  const router = useRouter();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);

  async function run(action: "APPROVED" | "REJECTED" | "CANCEL") {
    setBusy(action);
    try {
      if (action === "CANCEL") {
        await api(`/api/leaves/${l.id}/cancel`, { method: "POST", body: {} });
        toast.success(t("leaves.cancelled"));
      } else {
        const res = await api<{ leave: LeaveDTO; clashes: LeaveClash[] }>(`/api/leaves/${l.id}/decision`, { method: "POST", body: { decision: action, note } });
        toast.success(action === "APPROVED" ? t("leaves.approved") : t("leaves.rejected"));
        onClashes(res.clashes.length ? { name: res.leave.user.name, items: res.clashes } : null);
      }
      router.refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t("common.couldNotSave"));
      router.refresh();
    } finally {
      setBusy(null);
      setConfirmCancel(false);
    }
  }

  return (
    <li className="space-y-2 px-5 py-4" data-testid="leave-item">
      <div className="flex flex-wrap items-center gap-2">
        {manage && <span className="font-medium text-fg">{l.user.name}</span>}
        <Badge>{t.dyn(`enums.leaveType.${l.type}`)}</Badge>
        <span className="text-sm text-fg">{dayRangeLabel(l.startDate, l.endDate, t.locale)}</span>
        <span className="text-xs text-fg-subtle">{t("common.days", { count: l.days })}</span>
        <Badge className={cn("ms-auto", STATUS_TONE[l.status])}>{t.dyn(`enums.leaveStatus.${l.status}`)}</Badge>
      </div>
      {l.reason && <p className="text-sm text-fg-muted">{l.reason}</p>}
      <p className="text-xs text-fg-subtle">
        {l.requestedBy.id !== l.user.id ? t("leaves.addedBy", { name: l.requestedBy.name }) : t("leaves.byTechnician")}
        {l.decidedBy && l.requestedBy.id !== l.decidedBy.id && ` · ${t(l.status === "REJECTED" ? "leaves.rejectedBy" : "leaves.approvedBy", { name: l.decidedBy.name })}`}
        {l.decisionNote && ` · “${l.decisionNote}”`}
      </p>
      {(l.canDecide || l.canCancel) && (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {l.canDecide && (
            <>
              <Input
                aria-label={t("leaves.noteFor", { name: l.user.name })}
                placeholder={t("common.noteOptional")}
                className="h-9 max-w-xs flex-1"
                maxLength={500}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              <Button size="sm" loading={busy === "APPROVED"} disabled={busy !== null} onClick={() => run("APPROVED")}>
                <Check className="h-4 w-4" /> {t("leaves.approve")}
              </Button>
              <Button size="sm" variant="outline" loading={busy === "REJECTED"} disabled={busy !== null} onClick={() => run("REJECTED")}>
                <X className="h-4 w-4" /> {t("leaves.reject")}
              </Button>
            </>
          )}
          {l.canCancel &&
            (confirmCancel ? (
              <>
                <span className="text-sm text-fg-muted">{l.status === "APPROVED" ? t("leaves.endConfirm") : t("leaves.withdrawConfirm")}</span>
                <Button size="sm" variant="danger" loading={busy === "CANCEL"} onClick={() => run("CANCEL")}>
                  {t("leaves.yesCancel")}
                </Button>
                <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setConfirmCancel(false)}>
                  {t("leaves.keep")}
                </Button>
              </>
            ) : (
              <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setConfirmCancel(true)}>
                {t("leaves.cancelLeave")}
              </Button>
            ))}
        </div>
      )}
    </li>
  );
}
