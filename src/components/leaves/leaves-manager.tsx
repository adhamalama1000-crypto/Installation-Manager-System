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
import { api, ApiError } from "@/lib/api-client";
import { LEAVE_STATUS_LABELS, LEAVE_TYPES, LEAVE_TYPE_LABELS } from "@/lib/constants";
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
  const [clashes, setClashes] = useState<{ name: string; items: LeaveClash[] } | null>(null);
  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
      <div className="min-w-0 space-y-6 xl:col-start-2 xl:row-start-1">
        <LeaveForm overview={overview} technicians={technicians} manage={manage} onClashes={setClashes} />
      </div>
      <div className="min-w-0 space-y-6 xl:col-start-1 xl:row-start-1">
        {clashes && clashes.items.length > 0 && (
          <Alert tone="warning" title={`${clashes.name} has ${clashes.items.length} booking${clashes.items.length === 1 ? "" : "s"} during this leave`}>
            <p>Their Sales creators were notified. Assign another technician:</p>
            <ul className="mt-2 space-y-1">
              {clashes.items.map((c) => (
                <li key={c.appointmentId}>
                  <Link href={`/appointments/${c.appointmentId}/edit`} prefetch={false} className="font-medium text-brand-text hover:underline">
                    {c.code}
                  </Link>{" "}
                  · {c.customerName} · {fmt(c.startsAt, timezone, "EEE d MMM, HH:mm")}
                </li>
              ))}
            </ul>
            <button type="button" className="mt-2 text-xs font-medium text-fg-muted hover:underline" onClick={() => setClashes(null)}>
              Dismiss
            </button>
          </Alert>
        )}
        <LeaveList
          title={manage ? "Waiting for approval" : "My requests"}
          description={manage ? "Requests from technicians, oldest first." : "Requests an Admin has not decided yet."}
          items={overview.pending}
          manage={manage}
          empty="No requests waiting."
          onClashes={setClashes}
        />
        <LeaveList
          title="Approved and upcoming"
          description="Technicians cannot be booked on these days."
          items={overview.upcoming}
          manage={manage}
          empty="No approved leave coming up."
          onClashes={setClashes}
        />
        <LeaveList title="History" description="Past, rejected and cancelled leave (latest 30)." items={overview.past} manage={manage} empty="Nothing yet." onClashes={setClashes} />
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
    if (manage && !values.userId) fieldErrors.userId = "Choose a technician.";
    if (Object.keys(fieldErrors).length) {
      setErrors(fieldErrors);
      return;
    }
    setBusy(true);
    setErrors({});
    try {
      const res = await api<{ leave: LeaveDTO; clashes: LeaveClash[] }>("/api/leaves", { method: "POST", body });
      toast.success(manage ? "Leave recorded" : "Leave request sent to the Admins");
      onClashes(res.clashes.length ? { name: res.leave.user.name, items: res.clashes } : null);
      setValues((s) => ({ ...s, reason: "" }));
      router.refresh();
    } catch (err) {
      const apiErr = err instanceof ApiError ? err : new ApiError("Could not save", 0, "UNKNOWN");
      setErrors(apiErr.fieldErrors);
      toast.error(apiErr.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title={manage ? "Add leave" : "Ask for leave"}
        description={manage ? "Recorded as approved straight away." : "An Admin approves or rejects it; you are notified either way."}
        icon={<Plane className="h-4 w-4" />}
      />
      <form className="space-y-4 p-5" onSubmit={submit} noValidate>
        {manage && (
          <Field label="Technician" required error={errors.userId}>
            {(p) => (
              <Select {...p} value={values.userId} onChange={(e) => set("userId", e.target.value)}>
                <option value="">Choose…</option>
                {technicians.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <Field label="Type" required error={errors.type}>
          {(p) => (
            <Select {...p} value={values.type} onChange={(e) => set("type", e.target.value)}>
              {LEAVE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {LEAVE_TYPE_LABELS[t]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="First day" required error={errors.startDate}>
            {(p) => <Input {...p} type="date" min={manage ? undefined : overview.today} value={values.startDate} onChange={(e) => set("startDate", e.target.value)} />}
          </Field>
          <Field label="Last day" required error={errors.endDate}>
            {(p) => <Input {...p} type="date" min={values.startDate} value={values.endDate} onChange={(e) => set("endDate", e.target.value)} />}
          </Field>
        </div>
        <Field label="Reason" error={errors.reason} hint="Optional. Visible to Admins.">
          {(p) => <Textarea {...p} rows={2} maxLength={500} value={values.reason} onChange={(e) => set("reason", e.target.value)} />}
        </Field>
        {errors._form && <Alert tone="danger">{errors._form}</Alert>}
        <Button type="submit" className="w-full" loading={busy}>
          {manage ? "Add leave" : "Send request"}
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
  const router = useRouter();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);

  async function run(action: "APPROVED" | "REJECTED" | "CANCEL") {
    setBusy(action);
    try {
      if (action === "CANCEL") {
        await api(`/api/leaves/${l.id}/cancel`, { method: "POST", body: {} });
        toast.success("Leave cancelled");
      } else {
        const res = await api<{ leave: LeaveDTO; clashes: LeaveClash[] }>(`/api/leaves/${l.id}/decision`, { method: "POST", body: { decision: action, note } });
        toast.success(action === "APPROVED" ? "Leave approved" : "Leave rejected");
        onClashes(res.clashes.length ? { name: res.leave.user.name, items: res.clashes } : null);
      }
      router.refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not save");
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
        <Badge>{LEAVE_TYPE_LABELS[l.type]}</Badge>
        <span className="text-sm text-fg">{dayRangeLabel(l.startDate, l.endDate)}</span>
        <span className="text-xs text-fg-subtle">
          {l.days} day{l.days === 1 ? "" : "s"}
        </span>
        <Badge className={cn("ml-auto", STATUS_TONE[l.status])}>{LEAVE_STATUS_LABELS[l.status]}</Badge>
      </div>
      {l.reason && <p className="text-sm text-fg-muted">{l.reason}</p>}
      <p className="text-xs text-fg-subtle">
        {l.requestedBy.id !== l.user.id ? `Added by ${l.requestedBy.name}` : "Requested by the technician"}
        {l.decidedBy && l.requestedBy.id !== l.decidedBy.id && ` · ${l.status === "REJECTED" ? "Rejected" : "Approved"} by ${l.decidedBy.name}`}
        {l.decisionNote && ` · “${l.decisionNote}”`}
      </p>
      {(l.canDecide || l.canCancel) && (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {l.canDecide && (
            <>
              <Input
                aria-label={`Note for ${l.user.name}`}
                placeholder="Note (optional)"
                className="h-9 max-w-xs flex-1"
                maxLength={500}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              <Button size="sm" loading={busy === "APPROVED"} disabled={busy !== null} onClick={() => run("APPROVED")}>
                <Check className="h-4 w-4" /> Approve
              </Button>
              <Button size="sm" variant="outline" loading={busy === "REJECTED"} disabled={busy !== null} onClick={() => run("REJECTED")}>
                <X className="h-4 w-4" /> Reject
              </Button>
            </>
          )}
          {l.canCancel &&
            (confirmCancel ? (
              <>
                <span className="text-sm text-fg-muted">{l.status === "APPROVED" ? "End this leave?" : "Withdraw this request?"}</span>
                <Button size="sm" variant="danger" loading={busy === "CANCEL"} onClick={() => run("CANCEL")}>
                  Yes, cancel it
                </Button>
                <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setConfirmCancel(false)}>
                  Keep
                </Button>
              </>
            ) : (
              <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setConfirmCancel(true)}>
                Cancel leave
              </Button>
            ))}
        </div>
      )}
    </li>
  );
}
