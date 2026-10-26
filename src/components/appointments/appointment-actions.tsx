"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Ban, CalendarClock, CalendarPlus, Pencil, RefreshCw } from "lucide-react";
import { Button, ButtonLink } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Select, Textarea } from "@/components/ui/field";
import { Alert } from "@/components/ui/misc";
import { Ltr } from "@/components/ui/ltr";
import { useI18n } from "@/i18n/client";
import { api, ApiError } from "@/lib/api-client";
import type { ConflictDTO, StatusDTO } from "@/lib/types";

export function AppointmentActions({
  id,
  version,
  statusId,
  statusKind,
  statuses,
}: {
  id: string;
  version: number;
  statusId: string;
  statusKind: string;
  statuses: StatusDTO[];
}) {
  const { t, f, sn } = useI18n();
  const router = useRouter();
  const [statusOpen, setStatusOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [newStatus, setNewStatus] = useState(statusId);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<ConflictDTO[]>([]);

  function handleError(e: unknown) {
    const err = e instanceof ApiError ? e : new ApiError(t("act.unexpected"), 0, "UNKNOWN");
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
      toast.success(t("act.statusUpdated"));
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
      toast.success(t("act.cancelled"));
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
        <Pencil className="h-4 w-4" /> {t("act.edit")}
      </ButtonLink>
      <ButtonLink href={`/appointments/${id}/edit#schedule`} variant="outline">
        <CalendarClock className="h-4 w-4" /> {t("act.reschedule")}
      </ButtonLink>
      <ButtonLink href={`/appointments/new?followUp=${id}`} variant="outline">
        <CalendarPlus className="h-4 w-4" /> {t("act.followUp")}
      </ButtonLink>
      <Button variant="outline" onClick={() => { setError(null); setNewStatus(statusId); setStatusOpen(true); }}>
        <RefreshCw className="h-4 w-4" /> {t("act.changeStatus")}
      </Button>
      {statusKind !== "CANCELLED" && (
        <Button variant="ghost" className="text-danger hover:bg-danger-soft hover:text-danger" onClick={() => { setError(null); setCancelOpen(true); }}>
          <Ban className="h-4 w-4" /> {t("act.cancel")}
        </Button>
      )}

      <Dialog
        open={statusOpen}
        onClose={() => setStatusOpen(false)}
        title={t("act.changeStatus")}
        footer={
          <>
            <Button variant="outline" onClick={() => setStatusOpen(false)} disabled={busy}>
              {t("common.close")}
            </Button>
            <Button onClick={changeStatus} loading={busy} disabled={newStatus === statusId}>
              {t("act.saveStatus")}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {error && (
            <Alert tone="danger" title={t("act.cannotChange")}>
              {error}
              {conflicts.length > 0 && (
                <ul className="mt-1 list-disc ps-4">
                  {conflicts.map((c) => (
                    <li key={c.appointmentId + c.technicianId}>
                      {c.technicianName}: <Ltr>{f.timeRange(c.startsAt, c.endsAt)}</Ltr> (<Ltr>{c.appointmentCode}</Ltr>)
                    </li>
                  ))}
                </ul>
              )}
            </Alert>
          )}
          <Field label={t("act.newStatus")}>
            {(p) => (
              <Select {...p} value={newStatus} onChange={(e) => setNewStatus(e.target.value)}>
                {choices.map((s) => (
                  <option key={s.id} value={s.id}>
                    {sn(s)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t("common.note")} hint={t("act.noteHint")}>
            {(p) => <Textarea {...p} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />}
          </Field>
        </div>
      </Dialog>

      <Dialog
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        title={t("act.cancelTitle")}
        description={t("act.cancelDesc")}
        size="sm"
        footer={
          <>
            <Button variant="outline" onClick={() => setCancelOpen(false)} disabled={busy}>
              {t("act.keep")}
            </Button>
            <Button variant="danger" onClick={cancel} loading={busy}>
              {t("act.cancelAppointment")}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {error && <Alert tone="danger">{error}</Alert>}
          <Field label={t("common.reason")} hint={t("act.noteHint")}>
            {(p) => <Textarea {...p} rows={3} value={note} onChange={(e) => setNote(e.target.value)} />}
          </Field>
        </div>
      </Dialog>
    </>
  );
}
