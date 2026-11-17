"use client";

import { Archive, ArchiveRestore, Lock, LockOpen } from "lucide-react";
import { useT } from "@/i18n/client";
import { api } from "@/lib/api-client";
import { ConfirmButton } from "./confirm-dialog";
import { useAction } from "./use-action";

/** Lock / unlock / archive / bring back a product, each behind its own permission (the server re-checks). */
export function ItemStateActions({ id, sku, locked, archived, can }: { id: string; sku: string; locked: boolean; archived: boolean; can: { lock: boolean; unlock: boolean; archive: boolean } }) {
  const t = useT();
  const { busy, errors, run } = useAction();
  const go = (action: string, reason: string, done: string) => run(() => api(`/api/products/${id}/state`, { method: "POST", body: { action, reason } }), () => done).then((r) => r !== null);
  const reason = { label: t("itemLock.reason") };
  return (
    <>
      {!archived && !locked && can.lock && (
        <ConfirmButton variant="outline" size="sm" label={<><Lock className="h-4 w-4" /> {t("itemLock.lock")}</>} title={t("itemLock.lockTitle", { sku })} text={t("itemLock.lockText")} confirmLabel={t("itemLock.lock")} reason={reason} busy={busy} error={errors._form} onConfirm={(r) => go("lock", r, t("itemLock.done.locked"))} />
      )}
      {locked && can.unlock && (
        <ConfirmButton variant="outline" size="sm" label={<><LockOpen className="h-4 w-4" /> {t("itemLock.unlock")}</>} title={t("itemLock.unlockTitle", { sku })} text={t("itemLock.unlockText")} confirmLabel={t("itemLock.unlock")} reason={reason} busy={busy} error={errors._form} onConfirm={(r) => go("unlock", r, t("itemLock.done.unlocked"))} />
      )}
      {!archived && can.archive && (
        <ConfirmButton variant="ghost" size="sm" label={<><Archive className="h-4 w-4" /> {t("itemLock.archive")}</>} title={t("itemLock.archiveTitle", { sku })} text={t("itemLock.archiveText")} confirmLabel={t("itemLock.archive")} reason={reason} busy={busy} error={errors._form} onConfirm={(r) => go("archive", r, t("itemLock.done.archived"))} />
      )}
      {archived && can.archive && (
        <ConfirmButton variant="outline" size="sm" label={<><ArchiveRestore className="h-4 w-4" /> {t("itemLock.unarchive")}</>} title={t("itemLock.unarchiveTitle", { sku })} text={t("itemLock.unarchiveText")} confirmLabel={t("itemLock.unarchive")} reason={reason} busy={busy} error={errors._form} onConfirm={(r) => go("unarchive", r, t("itemLock.done.unarchived"))} />
      )}
    </>
  );
}
