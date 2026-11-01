"use client";

import { Pencil } from "lucide-react";
import { ButtonLink } from "@/components/ui/button";
import { useT } from "@/i18n/client";
import { api } from "@/lib/api-client";
import { ConfirmButton } from "./confirm-dialog";
import { useAction } from "./use-action";

/** Post, edit, cancel a draft, or cancel a posted document by reversal, each behind a confirmation. */
export function DocumentActions({ id, number, version, can }: { id: string; number: string; version: number; can: { edit: boolean; post: boolean; cancelDraft: boolean; reverse: boolean } }) {
  const t = useT();
  const { busy, errors, run } = useAction();
  const call = (path: string, body: unknown, done: string) => run(() => api(path, { method: "POST", body }), () => done).then((r) => r !== null);
  if (!can.edit && !can.post && !can.cancelDraft && !can.reverse) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {can.edit && (
        <ButtonLink href={`/stock/documents/${id}/edit`} variant="outline">
          <Pencil className="h-4 w-4" /> {t("stock.detail.editDraft")}
        </ButtonLink>
      )}
      {can.cancelDraft && (
        <ConfirmButton
          variant="ghost"
          label={t("stock.detail.cancelDraft")}
          title={t("stock.detail.cancelDraftTitle", { number })}
          text={t("stock.detail.cancelDraftText")}
          confirmLabel={t("stock.detail.cancelDraft")}
          busy={busy}
          error={errors._form}
          onConfirm={() => call(`/api/stock-documents/${id}/cancel`, { version }, t("stock.detail.cancelled", { number }))}
        />
      )}
      {can.post && (
        <ConfirmButton
          label={t("stock.detail.post")}
          title={t("stock.form.postConfirmTitle")}
          text={t("stock.form.postConfirmText")}
          confirmLabel={t("stock.detail.post")}
          busy={busy}
          error={errors._form}
          onConfirm={() => call(`/api/stock-documents/${id}/post`, {}, t("stock.detail.posted", { number }))}
        />
      )}
      {can.reverse && (
        <ConfirmButton
          variant="danger"
          label={t("stock.detail.reverse")}
          title={t("stock.detail.reverseTitle", { number })}
          text={t("stock.detail.reverseText")}
          confirmLabel={t("stock.detail.reverseSubmit")}
          reason={{ label: t("stock.detail.reverseReason"), required: true }}
          busy={busy}
          error={errors.reason ?? errors._form}
          onConfirm={(reason) => call(`/api/stock-documents/${id}/cancel`, { reason, version }, t("stock.detail.reversed", { number }))}
        />
      )}
    </div>
  );
}
