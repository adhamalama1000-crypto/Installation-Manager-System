import { History as HistoryIcon } from "lucide-react";
import { getT } from "@/i18n/server";
import type { T } from "@/i18n/translator";
import type { AuditEntryDTO } from "@/lib/types";
import { money } from "@/lib/constants";
import { dateTime } from "@/lib/format";

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const MONEY_KEYS = new Set(["totalPrice", "depositAmount", "extraFee", "collectedAmount", "amount"]);
/** Stored enum values shown with their translated name; anything else is shown as stored. */
const ENUM_KEYS: Record<string, string> = {
  productCategory: "enums.productCategory",
  visitType: "enums.visitType",
  customerConfirmation: "enums.confirmation",
  depositMethod: "enums.paymentMethod",
  collectedMethod: "enums.paymentMethod",
  role: "enums.role",
  type: "enums.leaveType",
  to: "enums.stockStatus",
  kind: "enums.statusKind",
};

export function formatAuditValue(v: unknown, tz: string, t: T, key?: string): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "string" && ISO_RE.test(v)) return dateTime(v, tz, t.locale);
  if (key && ENUM_KEYS[key] && typeof v === "string") return t.dyn(`${ENUM_KEYS[key]}.${v}`, undefined, v);
  if (key && MONEY_KEYS.has(key) && typeof v === "number") return money(v, t.locale);
  if (Array.isArray(v)) return v.length ? v.join(t.locale === "ar" ? "، " : ", ") : t("common.none");
  if (typeof v === "boolean") return v ? t("common.yes") : t("common.no");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export async function ChangeTable({ changes, tz }: { changes: AuditEntryDTO["changes"]; tz: string }) {
  if (!changes || typeof changes !== "object") return null;
  const rows = Object.entries(changes as Record<string, unknown>);
  if (!rows.length) return null;
  const t = await getT();
  return (
    <div className="mt-2 overflow-x-auto rounded-lg border border-line">
      <table className="w-full text-xs">
        <tbody className="divide-y divide-line">
          {rows.map(([key, val]) => {
            const isDiff = val && typeof val === "object" && !Array.isArray(val) && "from" in (val as object) && "to" in (val as object);
            const d = val as { from: unknown; to: unknown };
            return (
              <tr key={key} className="align-top">
                <th className="w-40 bg-surface-muted/60 px-3 py-1.5 text-start font-medium text-fg-muted">{t.dyn(`historyFields.${key}`, undefined, key)}</th>
                {isDiff ? (
                  <td className="px-3 py-1.5 text-fg">
                    <span className="text-fg-subtle line-through decoration-fg-subtle/60">{formatAuditValue(d.from, tz, t, key)}</span>
                    <span className="mx-1.5 text-fg-subtle">
                      <span className="rtl:hidden">→</span>
                      <span className="ltr:hidden">←</span>
                    </span>
                    <span>{formatAuditValue(d.to, tz, t, key)}</span>
                  </td>
                ) : (
                  <td className="px-3 py-1.5 text-fg">{formatAuditValue(val, tz, t, key)}</td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export async function HistoryList({ entries, tz }: { entries: AuditEntryDTO[]; tz: string }) {
  const t = await getT();
  if (!entries.length) return <p className="text-sm text-fg-muted">{t("history.empty")}</p>;
  return (
    <ol className="relative space-y-5 border-s border-line ps-5">
      {entries.map((e) => (
        <li key={e.id} className="relative">
          <span className="absolute -start-[27px] top-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full border-2 border-surface bg-brand" aria-hidden />
          <p className="text-sm text-fg">{e.summary}</p>
          <p className="mt-0.5 text-xs text-fg-subtle">
            {e.actor?.name ?? t("history.system")} · {dateTime(e.createdAt, tz, t.locale)}
          </p>
          {e.action !== "APPOINTMENT_CREATED" && <ChangeTable changes={e.changes} tz={tz} />}
        </li>
      ))}
    </ol>
  );
}

export { HistoryIcon };
