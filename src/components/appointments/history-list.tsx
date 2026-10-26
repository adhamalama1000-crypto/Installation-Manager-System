"use client";

import { History as HistoryIcon } from "lucide-react";
import { useI18n, type ClientI18n } from "@/i18n/client";
import { isMessageKey } from "@/i18n/translate";
import type { AuditEntryDTO } from "@/lib/types";

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

const ENUM_FIELDS = {
  productCategory: "category",
  visitType: "visitType",
  customerConfirmation: "confirmation",
  depositMethod: "paymentMethod",
  collectedMethod: "paymentMethod",
  role: "role",
} as const;
const MONEY_FIELDS = new Set(["totalPrice", "depositAmount", "extraFee", "collectedAmount", "amount"]);

/** Label of a changed field in the reader's language (unknown fields keep their key). */
export function fieldLabel(key: string, t: ClientI18n["t"]): string {
  const k = `field.${key}`;
  return isMessageKey(k) ? t(k) : key;
}

export function formatAuditValue(v: unknown, i18n: ClientI18n, key?: string): string {
  const { t, f, label, tm } = i18n;
  if (v === null || v === undefined || v === "") return "—";
  if (v === "(hidden)") return t("common.hidden");
  if (typeof v === "string" && ISO_RE.test(v)) return f.dateTime(v);
  if (key && key in ENUM_FIELDS && typeof v === "string") return label(ENUM_FIELDS[key as keyof typeof ENUM_FIELDS], v);
  if (key && MONEY_FIELDS.has(key) && typeof v === "number") return f.money(v);
  if (Array.isArray(v)) return v.length ? f.join(v.map(String)) : t("hist.none");
  if (typeof v === "boolean") return v ? t("common.yes") : t("common.no");
  if (typeof v === "object") return JSON.stringify(v);
  return tm(String(v));
}

export function ChangeTable({ changes }: { changes: AuditEntryDTO["changes"] }) {
  const i18n = useI18n();
  if (!changes || typeof changes !== "object") return null;
  const rows = Object.entries(changes as Record<string, unknown>);
  if (!rows.length) return null;
  return (
    <div className="mt-2 overflow-x-auto rounded-lg border border-line">
      <table className="w-full text-xs">
        <tbody className="divide-y divide-line">
          {rows.map(([key, val]) => {
            const isDiff = val && typeof val === "object" && !Array.isArray(val) && "from" in (val as object) && "to" in (val as object);
            const d = val as { from: unknown; to: unknown };
            return (
              <tr key={key} className="align-top">
                <th className="w-40 bg-surface-muted/60 px-3 py-1.5 text-start font-medium text-fg-muted">{fieldLabel(key, i18n.t)}</th>
                {isDiff ? (
                  <td className="px-3 py-1.5 text-fg">
                    <span className="text-fg-subtle line-through decoration-fg-subtle/60">{formatAuditValue(d.from, i18n, key)}</span>
                    <span className="mx-1.5 inline-block text-fg-subtle rtl:-scale-x-100">{"→"}</span>
                    <span>{formatAuditValue(d.to, i18n, key)}</span>
                  </td>
                ) : (
                  <td className="px-3 py-1.5 text-fg">{formatAuditValue(val, i18n, key)}</td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function HistoryList({ entries }: { entries: AuditEntryDTO[] }) {
  const { t, tm, f } = useI18n();
  if (!entries.length) return <p className="text-sm text-fg-muted">{t("hist.empty")}</p>;
  return (
    <ol className="relative space-y-5 border-s border-line ps-5">
      {entries.map((e) => (
        <li key={e.id} className="relative">
          <span className="absolute -start-[27px] top-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full border-2 border-surface bg-brand" aria-hidden />
          <p className="text-sm text-fg">{tm(e.summary)}</p>
          <p className="mt-0.5 text-xs text-fg-subtle">
            {e.actor?.name ?? t("hist.system")} · {f.dateTime(e.createdAt)}
          </p>
          {e.action !== "APPOINTMENT_CREATED" && <ChangeTable changes={e.changes} />}
        </li>
      ))}
    </ol>
  );
}

export { HistoryIcon };
