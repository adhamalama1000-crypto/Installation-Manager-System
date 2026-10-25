"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Ban, CalendarClock, Pencil, RefreshCw } from "lucide-react";
import { Button, ButtonLink } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Select, Textarea } from "@/components/ui/field";
import { Alert } from "@/components/ui/misc";
import { api, ApiError } from "@/lib/api-client";
import { timeRange } from "@/lib/format";
import type { ConflictDTO, StatusDTO } from "@/lib/types";

export function AppointmentActions({
  id,
  version,
  statusId,
  statusKind,
  statuses,
  tz,
}: {
  id: string;
  version: number;
  statusId: string;
  statusKind: string;
  statuses: StatusDTO[];
  tz: string;
}) {
  const router = useRouter();
  const [statusOpen, setStatusOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [newStatus, setNewStatus] = useState(statusId);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<ConflictDTO[]>([]);

  function handleError(e: unknown) {
    const err = e instanceof ApiError ? e : new ApiError("Unexpected error", 0, "UNKNOWN");
    setError(err.message);
    setConflicts(err.conflicts);
    toast.error(err.message);
  }

  async function changeStatus() {
    setBusy(true);
    setError(null);
    setConflicts([]);
    try {
      await api(`/api/appointments/${id}/status`, { method: "POST", body: { statusId: newStatus, version, note } });
      toast.success("Status updated");
      setStatusOpen(false);
      setNote("");
      router.refresh();
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/appointments/${id}/cancel`, { method: "POST", body: { version, reason: note } });
      toast.success("Appointment cancelled. The technicians' time slot is free again.");
      setCancelOpen(false);
      setNote("");
      router.refresh();
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(false);
    }
  }

  const choices = statuses.filter((s) => s.isActive || s.id === statusId);

  return (
    <>
      <ButtonLink href={`/appointments/${id}/edit`} variant="outline">
        <Pencil className="h-4 w-4" /> Edit
      </ButtonLink>
      <ButtonLink href={`/appointments/${id}/edit#schedule`} variant="outline">
        <CalendarClock className="h-4 w-4" /> Reschedule
      </ButtonLink>
      <Button variant="outline" onClick={() => { setError(null); setNewStatus(statusId); setStatusOpen(true); }}>
        <RefreshCw className="h-4 w-4" /> Change status
      </Button>
      {statusKind !== "CANCELLED" && (
        <Button variant="ghost" className="text-danger hover:bg-danger-soft hover:text-danger" onClick={() => { setError(null); setCancelOpen(true); }}>
          <Ban className="h-4 w-4" /> Cancel
        </Button>
      )}

      <Dialog
        open={statusOpen}
        onClose={() => setStatusOpen(false)}
        title="Change status"
        footer={
          <>
            <Button variant="outline" onClick={() => setStatusOpen(false)} disabled={busy}>
              Close
            </Button>
            <Button onClick={changeStatus} loading={busy} disabled={newStatus === statusId}>
              Save status
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {error && (
            <Alert tone="danger" title="Could not change status">
              {error}
              {conflicts.length > 0 && (
                <ul className="mt-1 list-disc pl-4">
                  {conflicts.map((c) => (
                    <li key={c.appointmentId + c.technicianId}>
                      {c.technicianName}: {timeRange(c.startsAt, c.endsAt, tz)} ({c.appointmentCode})
                    </li>
                  ))}
                </ul>
              )}
            </Alert>
          )}
          <Field label="New status">
            {(p) => (
              <Select {...p} value={newStatus} onChange={(e) => setNewStatus(e.target.value)}>
                {choices.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Note" hint="Optional - saved in the history">
            {(p) => <Textarea {...p} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />}
          </Field>
        </div>
      </Dialog>

      <Dialog
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        title="Cancel appointment?"
        description="The appointment stays in the history and the assigned technicians become available for that time."
        size="sm"
        footer={
          <>
            <Button variant="outline" onClick={() => setCancelOpen(false)} disabled={busy}>
              Keep appointment
            </Button>
            <Button variant="danger" onClick={cancel} loading={busy}>
              Cancel appointment
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {error && <Alert tone="danger">{error}</Alert>}
          <Field label="Reason" hint="Optional - saved in the history">
            {(p) => <Textarea {...p} rows={3} value={note} onChange={(e) => setNote(e.target.value)} />}
          </Field>
        </div>
      </Dialog>
    </>
  );
}
