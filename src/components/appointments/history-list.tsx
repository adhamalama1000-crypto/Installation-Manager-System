import { History as HistoryIcon } from "lucide-react";
import type { AuditEntryDTO } from "@/lib/types";
import { CONFIRMATION_LABELS, PRODUCT_CATEGORY_LABELS, VISIT_TYPE_LABELS } from "@/lib/constants";
import { dateTime } from "@/lib/format";

const FIELD_LABELS: Record<string, string> = {
  "customer.name": "Customer name",
  "customer.phone": "Primary phone",
  "customer.secondaryPhone": "Secondary phone",
  "location.area": "Area",
  "location.streetAddress": "Address",
  "location.building": "Compound / building",
  "location.apartment": "Apartment",
  "location.floor": "Floor",
  "location.accessInstructions": "Access instructions",
  "location.mapUrl": "Map link",
  "location.latitude": "Latitude",
  "location.longitude": "Longitude",
  productCategory: "Category",
  visitType: "Visit type",
  customerConfirmation: "Customer confirmation",
  categoryOther: "Category (other)",
  brand: "Brand",
  model: "Model",
  description: "Description",
  requiredEquipment: "Required equipment",
  additionalNotes: "Additional notes",
  internalNotes: "Internal notes",
  visitReport: "Visit report",
  startsAt: "Start",
  endsAt: "End",
  durationMinutes: "Duration (min)",
  technicians: "Technicians",
  status: "Status",
  note: "Note",
  createdBy: "Sales creator",
  name: "Name",
  email: "Email",
  phone: "Phone",
  role: "Role",
  isActive: "Active",
  color: "Colour",
  viewerPermissions: "Viewer permissions",
};

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

export function formatAuditValue(v: unknown, tz: string, key?: string): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "string" && ISO_RE.test(v)) return dateTime(v, tz);
  if (key === "productCategory" && typeof v === "string") return PRODUCT_CATEGORY_LABELS[v as keyof typeof PRODUCT_CATEGORY_LABELS] ?? v;
  if (key === "visitType" && typeof v === "string") return VISIT_TYPE_LABELS[v as keyof typeof VISIT_TYPE_LABELS] ?? v;
  if (key === "customerConfirmation" && typeof v === "string") return CONFIRMATION_LABELS[v as keyof typeof CONFIRMATION_LABELS] ?? v;
  if (Array.isArray(v)) return v.length ? v.join(", ") : "none";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export function ChangeTable({ changes, tz }: { changes: AuditEntryDTO["changes"]; tz: string }) {
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
                <th className="w-40 bg-surface-muted/60 px-3 py-1.5 text-left font-medium text-fg-muted">{FIELD_LABELS[key] ?? key}</th>
                {isDiff ? (
                  <td className="px-3 py-1.5 text-fg">
                    <span className="text-fg-subtle line-through decoration-fg-subtle/60">{formatAuditValue(d.from, tz, key)}</span>
                    <span className="mx-1.5 text-fg-subtle">→</span>
                    <span>{formatAuditValue(d.to, tz, key)}</span>
                  </td>
                ) : (
                  <td className="px-3 py-1.5 text-fg">{formatAuditValue(val, tz, key)}</td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function HistoryList({ entries, tz }: { entries: AuditEntryDTO[]; tz: string }) {
  if (!entries.length) return <p className="text-sm text-fg-muted">No history recorded.</p>;
  return (
    <ol className="relative space-y-5 border-l border-line pl-5">
      {entries.map((e) => (
        <li key={e.id} className="relative">
          <span className="absolute -left-[27px] top-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full border-2 border-surface bg-brand" aria-hidden />
          <p className="text-sm text-fg">{e.summary}</p>
          <p className="mt-0.5 text-xs text-fg-subtle">
            {e.actor?.name ?? "System"} · {dateTime(e.createdAt, tz)}
          </p>
          {e.action !== "APPOINTMENT_CREATED" && <ChangeTable changes={e.changes} tz={tz} />}
        </li>
      ))}
    </ol>
  );
}

export { HistoryIcon };
