"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Camera, CheckCircle2, CircleAlert, ImagePlus, PenLine, Trash2 } from "lucide-react";
import type { ProductCategory, StatusKind, VisitType } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/field";
import { useT } from "@/i18n/client";
import { api, apiUpload, ApiError } from "@/lib/api-client";
import { checklistItems, deliveryMissing, isHandoverVisit, type DeliveryRules } from "@/lib/delivery";
import { dateTime } from "@/lib/format";
import { preparePhoto } from "@/lib/image";
import type { AttachmentDTO, AttachmentRights, PaymentDTO } from "@/lib/types";
import { SignaturePad } from "./signature-pad";

type Kind = AttachmentDTO["kind"];
const PHOTO_KINDS: Kind[] = ["BEFORE_PHOTO", "AFTER_PHOTO"];
const MAX_PHOTOS = 20;

/**
 * Photos, the customer's signature, payment proofs and the delivery checklist of a visit (Aura's
 * delivery step). What a technician still needs before "Done" is listed when the Admin made it
 * required; the server enforces the same rules.
 */
export function DeliveryCard({
  id,
  productCategory,
  visitType,
  statusKind,
  canReport,
  enforced,
  rules,
  checklist,
  items,
  rights,
  payment,
  installedCount,
  tz,
}: {
  id: string;
  productCategory: ProductCategory;
  visitType: VisitType | null;
  statusKind: StatusKind;
  canReport: boolean;
  /** The reader is held to the delivery rules (technicians; managers are not). */
  enforced: boolean;
  rules: DeliveryRules;
  checklist: string[];
  items: AttachmentDTO[];
  rights: AttachmentRights;
  payment: PaymentDTO | null;
  installedCount: number;
  tz: string;
}) {
  const t = useT();
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();
  const [busyKind, setBusyKind] = useState<Kind | null>(null);
  const [signing, setSigning] = useState(false);
  const [removing, setRemoving] = useState<AttachmentDTO | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const fileInputs = useRef<Partial<Record<Kind, HTMLInputElement | null>>>({});
  // The checklist is owned by this page once loaded: a page refresh that started before a save
  // finished would carry older ticks. Saves run one after another, each sending the latest ticks,
  // so quick taps are never lost or saved out of order.
  const [ticked, setTicked] = useState<string[]>(checklist);
  const desired = useRef(checklist);
  const acked = useRef(checklist);
  const pending = useRef(0);
  const queue = useRef<Promise<void>>(Promise.resolve());

  const open = statusKind !== "CANCELLED";
  const byKind = (k: Kind) => items.filter((i) => i.kind === k);
  const handover = isHandoverVisit(visitType);
  const showChecklist = handover || checklist.length > 0;
  const allItems = checklistItems(productCategory);

  const missing =
    enforced && canReport && statusKind !== "COMPLETED" && (rules.requireDeliveryProof || rules.serialRequired)
      ? deliveryMissing(
          {
            productCategory,
            visitType,
            checklist: ticked,
            afterPhotos: byKind("AFTER_PHOTO").length,
            hasSignature: byKind("SIGNATURE").length > 0,
            hasPaymentProof: byKind("PAYMENT_PROOF").length > 0,
            collectedAmount: payment?.collectedAmount ?? null,
            collectedMethod: payment?.collectedMethod ?? null,
            installedSerials: installedCount,
          },
          rules,
        )
      : null;

  const slots: Kind[] = (["BEFORE_PHOTO", "AFTER_PHOTO", "SIGNATURE", "PAYMENT_PROOF", "DEPOSIT_PROOF"] as Kind[]).filter((k) => {
    if (byKind(k).length) return true;
    if (!open || !rights[k]) return false;
    if (k === "PAYMENT_PROOF") return payment !== null;
    if (k === "DEPOSIT_PROOF") return !!payment?.depositAmount;
    return true;
  });

  if (!slots.length && !showChecklist) return null;

  function failed(e: unknown) {
    toast.error(e instanceof ApiError ? e.message : t("common.couldNotSave"));
  }

  async function upload(kind: Kind, blob: Blob) {
    setBusyKind(kind);
    try {
      await apiUpload(`/api/appointments/${id}/attachments?kind=${kind}`, blob);
      toast.success(t("attachments.uploaded"));
      startRefresh(() => router.refresh());
    } catch (e) {
      failed(e);
      throw e;
    } finally {
      setBusyKind(null);
    }
  }

  async function pickPhoto(kind: Kind, file: File | undefined) {
    if (!file) return;
    let blob: Blob;
    try {
      blob = await preparePhoto(file);
    } catch {
      toast.error(t("attachments.errors.read"));
      return;
    }
    await upload(kind, blob).catch(() => undefined);
  }

  async function remove() {
    if (!removing) return;
    setRemoveBusy(true);
    try {
      await api(`/api/attachments/${removing.id}`, { method: "DELETE" });
      toast.success(t("attachments.removed"));
      setRemoving(null);
      startRefresh(() => router.refresh());
    } catch (e) {
      failed(e);
    } finally {
      setRemoveBusy(false);
    }
  }

  function toggle(item: string, on: boolean) {
    const next = desired.current.filter((x) => x !== item).concat(on ? [item] : []);
    desired.current = next;
    setTicked(next);
    pending.current++;
    queue.current = queue.current
      .then(async () => {
        const items = desired.current;
        if ([...items].sort().join() === [...acked.current].sort().join()) return;
        try {
          await api(`/api/appointments/${id}/checklist`, { method: "PUT", body: { items } });
          acked.current = items;
        } catch (e) {
          desired.current = acked.current;
          setTicked(acked.current);
          failed(e);
        }
      })
      .finally(() => {
        pending.current--;
        // Updates the history; the checklist itself keeps the ticks above.
        if (!pending.current) startRefresh(() => router.refresh());
      });
  }

  const canTick = open && canReport;

  return (
    <Card>
      <CardHeader title={t("attachments.title")} description={t("attachments.text")} icon={<Camera className="h-4 w-4" />} />
      <div className="divide-y divide-line">
        {missing && (
          <div className="p-5">
            {missing.length ? (
              <div className="rounded-lg border border-warning/40 bg-warning-soft p-3 text-sm">
                <p className="mb-1.5 flex items-center gap-2 font-medium text-fg">
                  <CircleAlert className="h-4 w-4 shrink-0 text-warning" /> {t("delivery.before")}
                </p>
                <ul className="list-disc space-y-0.5 ps-9 text-fg-muted">
                  {missing.map((m) => (
                    <li key={m.key}>{t(m.key, m.count ? { count: m.count } : undefined)}</li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="flex items-center gap-2 text-sm text-success">
                <CheckCircle2 className="h-4 w-4" /> {t("delivery.ready")}
              </p>
            )}
          </div>
        )}

        {showChecklist && (
          <fieldset className="p-5">
            <legend className="sr-only">{t("delivery.title")}</legend>
            <div className="mb-2 flex items-baseline justify-between gap-3">
              <h3 className="text-sm font-semibold text-fg">{t("delivery.title")}</h3>
              <span className="text-xs tabular-nums text-fg-subtle">{t("attachments.count", { count: ticked.filter((x) => allItems.includes(x)).length, max: allItems.length })}</span>
            </div>
            <p className="mb-3 text-xs text-fg-muted">{t("delivery.text")}</p>
            <div className="space-y-1">
              {allItems.map((item) => (
                <Checkbox
                  key={item}
                  label={t.dyn(`delivery.items.${item}`)}
                  checked={ticked.includes(item)}
                  disabled={!canTick}
                  onChange={(e) => toggle(item, e.target.checked)}
                />
              ))}
            </div>
          </fieldset>
        )}

        {slots.map((kind) => {
          const list = byKind(kind);
          const isPhoto = PHOTO_KINDS.includes(kind);
          const canAdd = open && rights[kind] && (!isPhoto || list.length < MAX_PHOTOS);
          const busy = busyKind === kind;
          return (
            <section key={kind} className="p-5" aria-labelledby={`att-${kind}`}>
              <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                <h3 id={`att-${kind}`} className="text-sm font-semibold text-fg">
                  {t.dyn(`attachments.kind.${kind}`)}
                  {isPhoto && list.length > 0 && <span className="ms-2 text-xs font-normal tabular-nums text-fg-subtle">{t("attachments.count", { count: list.length, max: MAX_PHOTOS })}</span>}
                </h3>
                {canAdd &&
                  (kind === "SIGNATURE" ? (
                    <Button size="sm" variant="outline" onClick={() => setSigning(true)} loading={busy}>
                      <PenLine className="h-4 w-4" /> {list.length ? t("attachments.signAgain") : t("attachments.sign")}
                    </Button>
                  ) : (
                    <>
                      <input
                        ref={(el) => {
                          fileInputs.current[kind] = el;
                        }}
                        type="file"
                        accept="image/*"
                        className="sr-only"
                        tabIndex={-1}
                        aria-hidden
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          e.target.value = "";
                          void pickPhoto(kind, file);
                        }}
                      />
                      <Button size="sm" variant="outline" onClick={() => fileInputs.current[kind]?.click()} loading={busy}>
                        <ImagePlus className="h-4 w-4" /> {isPhoto ? t("attachments.addPhoto") : list.length ? t("attachments.replace") : t("attachments.upload")}
                      </Button>
                    </>
                  ))}
              </div>
              <p className="mb-3 text-xs text-fg-muted">{t.dyn(`attachments.hint.${kind}`)}</p>
              {list.length ? (
                <ul className={kind === "SIGNATURE" ? "space-y-2" : "grid grid-cols-3 gap-2 sm:grid-cols-4"}>
                  {list.map((f) => (
                    <li key={f.id} className="group relative">
                      <a href={f.url} target="_blank" rel="noopener" className="block overflow-hidden rounded-lg border border-line bg-white" aria-label={t("attachments.open", { kind: t.dyn(`attachments.kind.${kind}`) })}>
                        {/* eslint-disable-next-line @next/next/no-img-element -- served through the permission-checked API, not the image optimizer */}
                        <img src={f.url} alt="" loading="lazy" className={kind === "SIGNATURE" ? "h-28 w-full object-contain" : "aspect-square w-full object-cover"} />
                      </a>
                      <p className="mt-1 truncate text-[11px] text-fg-subtle" title={f.uploadedBy.name}>
                        {t("attachments.by", { name: f.uploadedBy.name, when: dateTime(f.createdAt, tz, t.locale) })}
                      </p>
                      {f.canDelete && open && (
                        <button
                          type="button"
                          onClick={() => setRemoving(f)}
                          className="absolute end-1 top-1 rounded-md bg-surface/90 p-1 text-fg-muted shadow-card hover:text-danger"
                          aria-label={t("attachments.remove")}
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-fg-subtle">{t("attachments.none")}</p>
              )}
            </section>
          );
        })}
      </div>
      {refreshing && <span className="sr-only" aria-live="polite">{t("attachments.uploading")}</span>}

      <SignaturePad
        open={signing}
        onClose={() => setSigning(false)}
        onSave={async (png) => {
          await upload("SIGNATURE", png)
            .then(() => setSigning(false))
            .catch(() => undefined);
        }}
      />
      <Dialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title={t("attachments.removeTitle")}
        description={t("attachments.removeText")}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRemoving(null)} disabled={removeBusy}>
              {t("common.cancel")}
            </Button>
            <Button variant="danger" onClick={remove} loading={removeBusy}>
              {t("attachments.remove")}
            </Button>
          </>
        }
      >
        {removing && t.dyn(`attachments.kind.${removing.kind}`)}
      </Dialog>
    </Card>
  );
}
