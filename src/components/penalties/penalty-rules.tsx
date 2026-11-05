"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/field";
import { Badge } from "@/components/ui/misc";
import { useAction } from "@/components/erp/use-action";
import { useT } from "@/i18n/client";
import { api } from "@/lib/api-client";
import { money } from "@/lib/constants";
import { MINUTE_TRIGGERS, PENALTY_ACTIONS, PENALTY_TRIGGERS, type PenaltyActionValue, type PenaltyTriggerValue } from "@/lib/penalties";

export type RuleRow = {
  id: string;
  name: string;
  nameAr: string | null;
  trigger: PenaltyTriggerValue;
  action: PenaltyActionValue;
  amount: number;
  graceMinutes: number;
  maxAmount: number | null;
  warningsFirst: number;
  description: string | null;
  isActive: boolean;
};

/** The penalty rules; editable by those who manage penalties (the server checks again). */
export function PenaltyRules({ rules, canManage }: { rules: RuleRow[]; canManage: boolean }) {
  const t = useT();
  const [editing, setEditing] = useState<RuleRow | "new" | null>(null);
  const egp = (n: number) => money(n, t.locale);

  function summary(r: RuleRow): string {
    const parts = [r.action === "WARNING" ? t("penalties.actions.WARNING") : r.action === "FIXED" ? t("penalties.rules.fixed", { amount: egp(r.amount) }) : t("penalties.rules.perMinute", { amount: egp(r.amount) })];
    if (r.graceMinutes && MINUTE_TRIGGERS.includes(r.trigger)) parts.push(t("penalties.rules.after", { minutes: r.graceMinutes }));
    if (r.maxAmount !== null) parts.push(t("penalties.rules.cap", { amount: egp(r.maxAmount) }));
    if (r.warningsFirst && r.action !== "WARNING") parts.push(t("penalties.rules.firstWarnings", { count: r.warningsFirst }));
    return parts.join(" · ");
  }

  return (
    <div>
      {canManage && (
        <div className="flex justify-end px-5 pb-3">
          <Button size="sm" variant="outline" onClick={() => setEditing("new")}>
            <Plus className="h-4 w-4" /> {t("penalties.rules.add")}
          </Button>
        </div>
      )}
      {rules.length === 0 ? (
        <p className="px-5 pb-5 text-sm text-fg-muted">{t("penalties.rules.none")}</p>
      ) : (
        <ul className="divide-y divide-line border-t border-line" aria-label={t("penalties.rules.title")}>
          {rules.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3 text-sm">
              <span className="font-medium text-fg" dir="auto">
                {t.locale === "ar" && r.nameAr ? r.nameAr : r.name}
              </span>
              <Badge>{t(`penalties.triggers.${r.trigger}`)}</Badge>
              {!r.isActive && <Badge>{t("penalties.rules.inactive")}</Badge>}
              <span className="w-full text-xs text-fg-muted sm:w-auto">{summary(r)}</span>
              {canManage && (
                <Button size="sm" variant="ghost" className="ms-auto" onClick={() => setEditing(r)} aria-label={`${t("penalties.rules.edit")}: ${r.name}`}>
                  {t("common.edit")}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {editing && <RuleDialog initial={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function RuleDialog({ initial, onClose }: { initial: RuleRow | null; onClose: () => void }) {
  const t = useT();
  const { busy, errors, run } = useAction();
  const [v, setV] = useState({
    name: initial?.name ?? "",
    nameAr: initial?.nameAr ?? "",
    trigger: initial?.trigger ?? ("LATE_ARRIVAL" as PenaltyTriggerValue),
    action: initial?.action ?? ("WARNING" as PenaltyActionValue),
    amount: initial?.amount ? String(initial.amount) : "",
    graceMinutes: String(initial?.graceMinutes ?? 0),
    maxAmount: initial?.maxAmount ? String(initial.maxAmount) : "",
    warningsFirst: String(initial?.warningsFirst ?? 0),
    description: initial?.description ?? "",
    isActive: initial?.isActive ?? true,
  });
  const minutes = MINUTE_TRIGGERS.includes(v.trigger);
  async function save() {
    const r = await run(() => (initial ? api(`/api/penalties/rules/${initial.id}`, { method: "PATCH", body: v }) : api("/api/penalties/rules", { method: "POST", body: v })), () => t("penalties.rules.saved"));
    if (r) onClose();
  }
  return (
    <Dialog
      open
      onClose={onClose}
      title={initial ? t("penalties.rules.edit") : t("penalties.rules.add")}
      description={t("penalties.rules.text")}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button loading={busy} onClick={() => void save()}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label={t("penalties.rules.name")} required error={errors.name}>
          {(p) => <Input {...p} value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} maxLength={120} dir="auto" />}
        </Field>
        <Field label={t("penalties.rules.nameAr")} error={errors.nameAr}>
          {(p) => <Input {...p} value={v.nameAr} onChange={(e) => setV({ ...v, nameAr: e.target.value })} maxLength={120} dir="rtl" />}
        </Field>
        <Field label={t("penalties.rules.trigger")} required error={errors.trigger}>
          {(p) => (
            <Select
              {...p}
              value={v.trigger}
              onChange={(e) => {
                const trigger = e.target.value as PenaltyTriggerValue;
                setV({ ...v, trigger, action: v.action === "PER_MINUTE" && !MINUTE_TRIGGERS.includes(trigger) ? "FIXED" : v.action });
              }}
            >
              {PENALTY_TRIGGERS.map((x) => (
                <option key={x} value={x}>
                  {t(`penalties.triggers.${x}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t("penalties.rules.action")} required error={errors.action}>
          {(p) => (
            <Select {...p} value={v.action} onChange={(e) => setV({ ...v, action: e.target.value as PenaltyActionValue })}>
              {PENALTY_ACTIONS.filter((a) => a !== "PER_MINUTE" || minutes).map((x) => (
                <option key={x} value={x}>
                  {t(`penalties.actions.${x}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {v.action !== "WARNING" && (
          <Field label={v.action === "PER_MINUTE" ? t("penalties.rules.perMinuteAmount") : t("penalties.rules.amount")} required error={errors.amount}>
            {(p) => <Input {...p} inputMode="decimal" dir="ltr" value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} />}
          </Field>
        )}
        {v.action === "PER_MINUTE" && (
          <Field label={t("penalties.rules.max")} error={errors.maxAmount}>
            {(p) => <Input {...p} inputMode="decimal" dir="ltr" value={v.maxAmount} onChange={(e) => setV({ ...v, maxAmount: e.target.value })} />}
          </Field>
        )}
        {minutes && (
          <Field label={t("penalties.rules.grace")} hint={t("penalties.rules.graceHint")} error={errors.graceMinutes}>
            {(p) => <Input {...p} type="number" min={0} max={600} inputMode="numeric" dir="ltr" value={v.graceMinutes} onChange={(e) => setV({ ...v, graceMinutes: e.target.value })} />}
          </Field>
        )}
        {v.action !== "WARNING" && (
          <Field label={t("penalties.rules.warningsFirst")} hint={t("penalties.rules.warningsFirstHint")} error={errors.warningsFirst}>
            {(p) => <Input {...p} type="number" min={0} max={31} inputMode="numeric" dir="ltr" value={v.warningsFirst} onChange={(e) => setV({ ...v, warningsFirst: e.target.value })} />}
          </Field>
        )}
        <Field label={t("penalties.rules.description")} error={errors.description} className="sm:col-span-2">
          {(p) => <Textarea {...p} rows={2} maxLength={500} dir="auto" value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} />}
        </Field>
        <Checkbox label={t("penalties.rules.active")} checked={v.isActive} onChange={(e) => setV({ ...v, isActive: e.target.checked })} />
      </div>
    </Dialog>
  );
}
