"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { MessageSquareWarning } from "lucide-react";
import { Button, ButtonLink } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Select, Textarea } from "@/components/ui/field";
import { useT } from "@/i18n/client";
import { api, ApiError } from "@/lib/api-client";
import { shortDate } from "@/lib/format";
import type { ComplaintDTO } from "@/lib/types";

/** "Open complaint" on a visit (Sales on bookings they manage, Admins). */
export function OpenComplaintButton({ appointmentId, code }: { appointmentId: string; code: string }) {
  const t = useT();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(undefined);
    try {
      const { complaint } = await api<{ complaint: ComplaintDTO }>(`/api/appointments/${appointmentId}/complaints`, { method: "POST", body: { description: text } });
      toast.success(t("complaints.opened", { code: complaint.code }));
      setOpen(false);
      setText("");
      router.push(`/complaints/${complaint.id}`);
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError(t("common.couldNotSave"), 0, "UNKNOWN");
      setError(err.fieldErrors.description ?? err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <MessageSquareWarning className="h-4 w-4" /> {t("complaints.open")}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={t("complaints.openTitle")}
        description={t("complaints.openText", { code })}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              {t("common.cancel")}
            </Button>
            <Button onClick={submit} loading={busy}>
              {t("complaints.open")}
            </Button>
          </>
        }
      >
        <Field label={t("complaints.description")} required hint={t("complaints.descriptionHint")} error={error}>
          {(p) => <Textarea {...p} rows={4} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} />}
        </Field>
      </Dialog>
    </>
  );
}

type VisitOption = { id: string; code: string; startsAt: string; statusName: string };

/** Assign, link the maintenance visit, resolve, close or reopen a complaint. */
export function ComplaintActions({
  complaint: c,
  technicians,
  visits,
  tz,
}: {
  complaint: ComplaintDTO;
  technicians: { id: string; name: string }[];
  visits: VisitOption[];
  tz: string;
}) {
  const t = useT();
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [tech, setTech] = useState(c.assignedTo?.id ?? "");
  const [visit, setVisit] = useState(c.visit?.id ?? "");
  const [resolution, setResolution] = useState(c.resolution ?? "");

  async function act(body: Record<string, unknown>, done: string) {
    setBusy(String(body.action));
    setErrors({});
    try {
      await api(`/api/complaints/${c.id}`, { method: "PATCH", body: { ...body, version: c.version } });
      toast.success(done);
      router.refresh();
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError(t("common.couldNotSave"), 0, "UNKNOWN");
      setErrors(err.fieldErrors);
      toast.error(err.message);
      if (err.code === "STALE_RECORD") router.refresh();
    } finally {
      setBusy(null);
    }
  }

  const { rights } = c;
  if (!rights.assign && !rights.linkVisit && !rights.resolve && !rights.close && !rights.reopen) return null;
  return (
    <div className="space-y-5">
      {rights.assign && (
        <div className="flex flex-wrap items-end gap-2">
          <Field label={t("complaints.assignTo")} error={errors.technicianId} className="min-w-0 flex-1 basis-48">
            {(p) => (
              <Select {...p} value={tech} onChange={(e) => setTech(e.target.value)}>
                <option value="">{t("complaints.unassigned")}</option>
                {technicians.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Button variant="outline" disabled={tech === (c.assignedTo?.id ?? "")} loading={busy === "assign"} onClick={() => act({ action: "assign", technicianId: tech || null }, t("complaints.assigned"))}>
            {t("complaints.assign")}
          </Button>
        </div>
      )}

      {rights.linkVisit && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-end gap-2">
            <Field label={t("complaints.maintenanceVisit")} hint={t("complaints.maintenanceVisitHint")} error={errors.visitId} className="min-w-0 flex-1 basis-48">
              {(p) => (
                <Select {...p} value={visit} onChange={(e) => setVisit(e.target.value)}>
                  <option value="">{t("complaints.noVisit")}</option>
                  {visits.map((v) => (
                    <option key={v.id} value={v.id}>
                      {`${v.code} · ${shortDate(v.startsAt, tz, t.locale)} · ${v.statusName}`}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Button variant="outline" disabled={visit === (c.visit?.id ?? "")} loading={busy === "linkVisit"} onClick={() => act({ action: "linkVisit", visitId: visit || null }, t("complaints.visitLinked"))}>
              {t("complaints.linkVisit")}
            </Button>
          </div>
          <ButtonLink href={`/appointments/new?followUp=${c.appointment.id}`} variant="ghost" size="sm">
            {t("complaints.bookVisit")}
          </ButtonLink>
        </div>
      )}

      {rights.resolve && (
        <div className="space-y-2">
          <Field label={t("complaints.resolution")} required hint={t("complaints.resolutionHint")} error={errors.resolution}>
            {(p) => <Textarea {...p} rows={3} maxLength={2000} value={resolution} onChange={(e) => setResolution(e.target.value)} />}
          </Field>
          <Button loading={busy === "resolve"} disabled={!resolution.trim() || resolution.trim() === (c.resolution ?? "")} onClick={() => act({ action: "resolve", resolution }, t("complaints.resolved"))}>
            {t("complaints.resolve")}
          </Button>
        </div>
      )}

      {(rights.close || rights.reopen) && (
        <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
          {rights.close && (
            <>
              <Button variant="secondary" loading={busy === "close"} onClick={() => act({ action: "close" }, t("complaints.closed"))}>
                {t("complaints.close")}
              </Button>
              <span className="text-xs text-fg-muted">{t("complaints.closeHint")}</span>
            </>
          )}
          {rights.reopen && (
            <Button variant="outline" loading={busy === "reopen"} onClick={() => act({ action: "reopen" }, t("complaints.reopened"))}>
              {t("complaints.reopen")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
