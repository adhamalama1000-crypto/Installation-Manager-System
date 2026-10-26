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
import { Ltr } from "@/components/ui/ltr";
import { Alert, Badge, EmptyState } from "@/components/ui/misc";
import { useI18n } from "@/i18n/client";
import { api, ApiError } from "@/lib/api-client";
import { LEAVE_TYPES } from "@/lib/constants";
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
}: {
  overview: Overview;
  technicians: { id: string; name: string }[];
  manage: boolean;
}) {
  const { t, f } = useI18n();
  const [clashes, setClashes] = useState<{ name: string; items: LeaveClash[] } | null>(null);
  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
      <div className="min-w-0 space-y-6 xl:col-start-2 xl:row-start-1">
        <LeaveForm overview={overview} technicians={technicians} manage={manage} onClashes={setClashes} />
      </div>
      <div className="min-w-0 space-y-6 xl:col-start-1 xl:row-start-1">
        {clashes && clashes.items.length > 0 && (
          <Alert tone="warning" title={t("leave.clashTitle", { name: clashes.name, count: clashes.items.length })}>
            <p>{t("leave.clashText")}</p>
            <ul className="mt-2 space-y-1">
              {clashes.items.map((c) => (
                <li key={c.appointmentId}>
                  <Link href={`/appointments/${c.appointmentId}/edit`} prefetch={false} className="font-medium text-brand-text hover:underline">
                    <Ltr>{c.code}</Ltr>
                  </Link>{" "}
                  · {c.customerName} · {f.dateTime(c.startsAt)}
                </li>
              ))}
            </ul>
            <button type="button" className="mt-2 text-xs font-medium text-fg-muted hover:underline" onClick={() => setClashes(null)}>
              {t("leave.dismiss")}
            </button>
          </Alert>
        )}
        <LeaveList
          title={manage ? t("leave.pendingManage") : t("leave.pendingOwn")}
          description={manage ? t("leave.pendingManageDesc") : t("leave.pendingOwnDesc")}
          items={overview.pending}
          manage={manage}
          empty={t("leave.noneWaiting")}
          onClashes={setClashes}
        />
        <LeaveList
          title={t("leave.upcoming")}
          description={t("leave.upcomingDesc")}
          items={overview.upcoming}
          manage={manage}
          empty={t("leave.noneUpcoming")}
          onClashes={setClashes}
        />
        <LeaveList title={t("leave.history")} description={t("leave.historyDesc")} items={overview.past} manage={manage} empty={t("leave.nothingYet")} onClashes={setClashes} />
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
  const { t, tm, label } = useI18n();
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
    if (manage && !values.userId) fieldErrors.userId = t("leave.chooseTechnician");
    if (Object.keys(fieldErrors).length) {
      setErrors(fieldErrors);
      return;
    }
    setBusy(true);
    setErrors({});
    try {
      const res = await api<{ leave: LeaveDTO; clashes: LeaveClash[] }>("/api/leaves", { method: "POST", body });
      toast.success(manage ? t("leave.recorded") : t("leave.sent"));
      onClashes(res.clashes.length ? { name: res.leave.user.name, items: res.clashes } : null);
      setValues((s) => ({ ...s, reason: "" }));
      router.refresh();
    } catch (err) {
      const apiErr = err instanceof ApiError ? err : new ApiError(t("act.couldNotSave"), 0, "UNKNOWN");
      setErrors(apiErr.fieldErrors);
      toast.error(apiErr.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title={manage ? t("leave.addTitle") : t("leave.askTitle")}
        description={manage ? t("leave.addDesc") : t("leave.askDesc")}
        icon={<Plane className="h-4 w-4" />}
      />
      <form className="space-y-4 p-5" onSubmit={submit} noValidate>
        {manage && (
          <Field label={t("leave.technician")} required error={errors.userId}>
            {(p) => (
              <Select {...p} value={values.userId} onChange={(e) => set("userId", e.target.value)}>
                <option value="">{t("form.choose")}</option>
                {technicians.map((tech) => (
                  <option key={tech.id} value={tech.id}>
                    {tech.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <Field label={t("leave.type")} required error={errors.type}>
          {(p) => (
            <Select {...p} value={values.type} onChange={(e) => set("type", e.target.value)}>
              {LEAVE_TYPES.map((lt) => (
                <option key={lt} value={lt}>
                  {label("leaveType", lt)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("leave.firstDay")} required error={errors.startDate}>
            {(p) => <Input {...p} type="date" min={manage ? undefined : overview.today} value={values.startDate} onChange={(e) => set("startDate", e.target.value)} />}
          </Field>
          <Field label={t("leave.lastDay")} required error={errors.endDate}>
            {(p) => <Input {...p} type="date" min={values.startDate} value={values.endDate} onChange={(e) => set("endDate", e.target.value)} />}
          </Field>
        </div>
        <Field label={t("leave.reason")} error={errors.reason} hint={t("leave.reasonHint")}>
          {(p) => <Textarea {...p} rows={2} maxLength={500} value={values.reason} onChange={(e) => set("reason", e.target.value)} />}
        </Field>
        {errors._form && <Alert tone="danger">{tm(errors._form)}</Alert>}
        <Button type="submit" className="w-full" loading={busy}>
          {manage ? t("leave.addTitle") : t("leave.send")}
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
  const { t, f, label } = useI18n();
  const router = useRouter();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);

  async function run(action: "APPROVED" | "REJECTED" | "CANCEL") {
    setBusy(action);
    try {
      if (action === "CANCEL") {
        await api(`/api/leaves/${l.id}/cancel`, { method: "POST", body: {} });
        toast.success(t("leave.cancelled"));
      } else {
        const res = await api<{ leave: LeaveDTO; clashes: LeaveClash[] }>(`/api/leaves/${l.id}/decision`, { method: "POST", body: { decision: action, note } });
        toast.success(action === "APPROVED" ? t("leave.approved") : t("leave.rejected"));
        onClashes(res.clashes.length ? { name: res.leave.user.name, items: res.clashes } : null);
      }
      router.refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t("act.couldNotSave"));
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
        <Badge>{label("leaveType", l.type)}</Badge>
        <span className="text-sm text-fg">{f.dayRange(l.startDate, l.endDate)}</span>
        <span className="text-xs text-fg-subtle">{t("common.daysCount", { count: l.days })}</span>
        <Badge className={cn("ms-auto", STATUS_TONE[l.status])}>{label("leaveStatus", l.status)}</Badge>
      </div>
      {l.reason && <p className="text-sm text-fg-muted">{l.reason}</p>}
      <p className="text-xs text-fg-subtle">
        {l.requestedBy.id !== l.user.id ? t("leave.addedBy", { name: l.requestedBy.name }) : t("leave.requestedByTech")}
        {l.decidedBy && l.requestedBy.id !== l.decidedBy.id && ` · ${t(l.status === "REJECTED" ? "leave.rejectedBy" : "leave.approvedBy", { name: l.decidedBy.name })}`}
        {l.decisionNote && ` · “${l.decisionNote}”`}
      </p>
      {(l.canDecide || l.canCancel) && (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {l.canDecide && (
            <>
              <Input
                aria-label={t("leave.noteFor", { name: l.user.name })}
                placeholder={t("leave.notePlaceholder")}
                className="h-9 max-w-xs flex-1"
                maxLength={500}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              <Button size="sm" loading={busy === "APPROVED"} disabled={busy !== null} onClick={() => run("APPROVED")}>
                <Check className="h-4 w-4" /> {t("leave.approve")}
              </Button>
              <Button size="sm" variant="outline" loading={busy === "REJECTED"} disabled={busy !== null} onClick={() => run("REJECTED")}>
                <X className="h-4 w-4" /> {t("leave.reject")}
              </Button>
            </>
          )}
          {l.canCancel &&
            (confirmCancel ? (
              <>
                <span className="text-sm text-fg-muted">{l.status === "APPROVED" ? t("leave.endConfirm") : t("leave.withdrawConfirm")}</span>
                <Button size="sm" variant="danger" loading={busy === "CANCEL"} onClick={() => run("CANCEL")}>
                  {t("leave.yesCancel")}
                </Button>
                <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setConfirmCancel(false)}>
                  {t("leave.keep")}
                </Button>
              </>
            ) : (
              <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setConfirmCancel(true)}>
                {t("leave.cancelLeave")}
              </Button>
            ))}
        </div>
      )}
    </li>
  );
}
