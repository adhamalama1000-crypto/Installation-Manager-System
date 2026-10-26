"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Boxes } from "lucide-react";
import type { StockStatus } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/field";
import { Ltr } from "@/components/ui/ltr";
import { Badge, EmptyState } from "@/components/ui/misc";
import { useI18n } from "@/i18n/client";
import { api, ApiError } from "@/lib/api-client";
import { STOCK_MOVE_TARGETS } from "@/lib/validation";
import { cn } from "@/lib/utils";

type Item = {
  id: string;
  serial: string;
  status: StockStatus;
  model: { id: string; name: string };
  holder: { id: string; name: string } | null;
  appointment: { id: string; code: string } | null;
  warrantyUntil: string | null;
  note: string | null;
  updatedAt: string;
};

const TONE: Record<StockStatus, string> = {
  IN_STORE: "border-info/40 bg-info-soft text-fg",
  WITH_TECHNICIAN: "border-warning/40 bg-warning-soft text-fg",
  INSTALLED: "border-success/40 bg-success-soft text-fg",
  RETURNED: "",
  FAULTY: "border-danger/40 bg-danger-soft text-fg",
};


export function StockTable({
  items,
  canManage,
  technicians,
  historyHref,
}: {
  items: Item[];
  canManage: boolean;
  technicians: { id: string; name: string }[];
  historyHref: Record<string, string>;
}) {
  const { t, tm, f, label } = useI18n();
  const router = useRouter();
  const [selected, setSelected] = useState<string[]>([]);
  const [to, setTo] = useState<(typeof STOCK_MOVE_TARGETS)[number]>("WITH_TECHNICIAN");
  const [technicianId, setTechnicianId] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const visible = selected.filter((id) => items.some((i) => i.id === id));
  const allOnPage = items.length > 0 && items.every((i) => visible.includes(i.id));

  async function move() {
    setBusy(true);
    try {
      const res = await api<{ count: number }>("/api/stock/move", { method: "POST", body: { itemIds: visible, to, technicianId: technicianId || null, note } });
      toast.success(res.count ? t("inv.updated", { count: res.count }) : t("inv.nothingToChange"));
      setSelected([]);
      setNote("");
      router.refresh();
    } catch (e) {
      toast.error(e instanceof ApiError ? tm(Object.values(e.fieldErrors)[0] ?? e.message) : t("act.couldNotSave"));
    } finally {
      setBusy(false);
    }
  }

  if (!items.length) return <EmptyState title={t("inv.noItems")} icon={<Boxes className="h-6 w-6" />} />;

  return (
    <>
      {canManage && visible.length > 0 && (
        <div className="sticky top-16 z-10 flex flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-3" role="region" aria-label={t("inv.moveRegion")}>
          <span className="text-sm font-medium text-fg">{t("inv.selected", { count: visible.length })}</span>
          <Select aria-label={t("inv.moveTo")} className="h-9 w-auto" value={to} onChange={(e) => setTo(e.target.value as typeof to)}>
            {STOCK_MOVE_TARGETS.map((target) => (
              <option key={target} value={target}>
                {t(`inv.target.${target}`)}
              </option>
            ))}
          </Select>
          {to === "WITH_TECHNICIAN" && (
            <Select aria-label={t("inv.technician")} className="h-9 w-auto" value={technicianId} onChange={(e) => setTechnicianId(e.target.value)}>
              <option value="">{t("inv.chooseTechnician")}</option>
              {technicians.map((tech) => (
                <option key={tech.id} value={tech.id}>
                  {tech.name}
                </option>
              ))}
            </Select>
          )}
          <Input aria-label={t("common.note")} placeholder={t("leave.notePlaceholder")} className="h-9 w-48 flex-1" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
          <Button size="sm" loading={busy} disabled={to === "WITH_TECHNICIAN" && !technicianId} onClick={move}>
            {t("common.apply")}
          </Button>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="bg-surface-muted/60 text-start text-xs uppercase tracking-wide text-fg-muted">
            <tr>
              {canManage && (
                <th className="w-10 px-4 py-2">
                  <input
                    type="checkbox"
                    aria-label={t("inv.selectAll")}
                    checked={allOnPage}
                    onChange={() => setSelected(allOnPage ? [] : items.map((i) => i.id))}
                  />
                </th>
              )}
              <th className="px-4 py-2 text-start font-medium">{t("inv.colSerial")}</th>
              <th className="px-4 py-2 text-start font-medium">{t("inv.colModel")}</th>
              <th className="px-4 py-2 text-start font-medium">{t("inv.colStatus")}</th>
              <th className="px-4 py-2 text-start font-medium">{t("inv.colWhere")}</th>
              <th className="px-4 py-2 text-start font-medium">{t("inv.colUpdated")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {items.map((i) => (
              <tr key={i.id} className={cn(visible.includes(i.id) && "bg-brand-soft/40")} data-testid="stock-row">
                {canManage && (
                  <td className="px-4 py-2">
                    <input
                      type="checkbox"
                      aria-label={t("inv.select", { serial: i.serial })}
                      checked={visible.includes(i.id)}
                      onChange={() => setSelected((s) => (s.includes(i.id) ? s.filter((x) => x !== i.id) : [...s, i.id]))}
                    />
                  </td>
                )}
                <td className="px-4 py-2">
                  <Link href={historyHref[i.serial] ?? "#"} prefetch={false} className="font-mono font-medium text-brand-text hover:underline">
                    <Ltr>{i.serial}</Ltr>
                  </Link>
                </td>
                <td className="px-4 py-2 text-fg">{i.model.name}</td>
                <td className="px-4 py-2">
                  <Badge className={TONE[i.status]}>{label("stockStatus", i.status)}</Badge>
                </td>
                <td className="px-4 py-2 text-fg-muted">
                  {i.holder?.name}
                  {i.appointment && (
                    <Link href={`/appointments/${i.appointment.id}`} prefetch={false} className="font-mono text-brand-text hover:underline">
                      <Ltr>{i.appointment.code}</Ltr>
                    </Link>
                  )}
                  {i.warrantyUntil && (
                    <span className="block text-xs text-fg-subtle">{t("inv.warrantyUntil", { date: f.day(i.warrantyUntil, { day: "numeric", month: "short", year: "numeric" }) })}</span>
                  )}
                  {i.note && <span className="block text-xs text-fg-subtle">{i.note}</span>}
                </td>
                <td className="px-4 py-2 text-xs text-fg-subtle">{f.dateTime(i.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
