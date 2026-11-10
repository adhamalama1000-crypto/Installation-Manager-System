"use client";

import { useState } from "react";
import { FilePlus2, ScanSearch } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { useAction } from "@/components/erp/use-action";
import { useT } from "@/i18n/client";
import { api } from "@/lib/api-client";
import type { ViolationKindValue } from "@/lib/penalties";

type Person = { id: string; name: string; role: string };
type ManualRule = { id: string; name: string; nameAr: string | null; action: "WARNING" | "FIXED" | "PER_MINUTE"; amount: number };

/** Records a violation by hand (proposed only). */
export function RecordViolation({ people, rules, today }: { people: Person[]; rules: ManualRule[]; today: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const empty = { userId: null as string | null, ruleId: "", occurredOn: today, kind: "WARNING" as ViolationKindValue, amount: "", description: "" };
  const [v, setV] = useState(empty);
  const { busy, errors, run } = useAction();
  const ruleName = (r: ManualRule) => (t.locale === "ar" && r.nameAr ? r.nameAr : r.name);

  function pickRule(id: string) {
    const r = rules.find((x) => x.id === id);
    // A rule fills in its penalty; it can still be changed before saving.
    setV((x) => ({ ...x, ruleId: id, ...(r ? { kind: r.action === "WARNING" ? "WARNING" : "DEDUCTION", amount: r.action === "WARNING" ? "" : String(r.amount), description: x.description || ruleName(r) } : {}) }));
  }

  async function save() {
    const r = await run(() => api("/api/penalties", { method: "POST", body: { ...v, userId: v.userId ?? "" } }), () => t("penalties.recorded"));
    if (r) {
      setOpen(false);
      setV(empty);
    }
  }

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <FilePlus2 className="h-4 w-4" /> {t("penalties.record")}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={t("penalties.recordTitle")}
        description={t("penalties.recordText")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              {t("common.cancel")}
            </Button>
            <Button loading={busy} onClick={() => void save()}>
              {t("common.save")}
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={t("penalties.employee")} required error={errors.userId}>
            {(p) => (
              <Combobox
                id={p.id}
                label={t("penalties.employee")}
                options={people.map((x) => ({ id: x.id, label: x.name, hint: t.dyn(`enums.role.${x.role}`, undefined, x.role) }))}
                value={v.userId}
                onChange={(id) => setV({ ...v, userId: id })}
                invalid={!!p["aria-invalid"]}
              />
            )}
          </Field>
          <Field label={t("penalties.date")} required error={errors.occurredOn}>
            {(p) => <Input {...p} type="date" max={today} value={v.occurredOn} onChange={(e) => setV({ ...v, occurredOn: e.target.value })} />}
          </Field>
          {rules.length > 0 && (
            <Field label={t("penalties.rule")} error={errors.ruleId} className="sm:col-span-2">
              {(p) => (
                <Select {...p} value={v.ruleId} onChange={(e) => pickRule(e.target.value)}>
                  <option value="">{t("penalties.noRule")}</option>
                  {rules.map((r) => (
                    <option key={r.id} value={r.id}>
                      {ruleName(r)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
          <Field label={t("penalties.kind")} required error={errors.kind}>
            {(p) => (
              <Select {...p} value={v.kind} onChange={(e) => setV({ ...v, kind: e.target.value as ViolationKindValue })}>
                <option value="WARNING">{t("penalties.kinds.WARNING")}</option>
                <option value="DEDUCTION">{t("penalties.kinds.DEDUCTION")}</option>
              </Select>
            )}
          </Field>
          {v.kind === "DEDUCTION" && (
            <Field label={t("penalties.amount")} required error={errors.amount}>
              {(p) => <Input {...p} inputMode="decimal" dir="ltr" value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} />}
            </Field>
          )}
          <Field label={t("penalties.description")} required error={errors.description} className="sm:col-span-2">
            {(p) => <Textarea {...p} rows={3} maxLength={1000} dir="auto" value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} />}
          </Field>
        </div>
      </Dialog>
    </>
  );
}

/** Applies the active rules to a period of attendance and work reviews (proposes only). */
export function FindViolations({ from, to }: { from: string; to: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [range, setRange] = useState({ from, to });
  const { busy, errors, run } = useAction();
  async function scan() {
    const r = await run(
      () => api<{ created: number }>("/api/penalties/scan", { method: "POST", body: range }),
      (x) => t("penalties.scanned", { count: x.created }),
    );
    if (r) setOpen(false);
  }
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <ScanSearch className="h-4 w-4" /> {t("penalties.scan")}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={t("penalties.scanTitle")}
        description={t("penalties.scanText")}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              {t("common.cancel")}
            </Button>
            <Button loading={busy} onClick={() => void scan()}>
              {t("penalties.scan")}
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("penalties.from")} error={errors.from}>
            {(p) => <Input {...p} type="date" max={to} value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />}
          </Field>
          <Field label={t("penalties.to")} error={errors.to}>
            {(p) => <Input {...p} type="date" max={to} value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />}
          </Field>
        </div>
      </Dialog>
    </>
  );
}
