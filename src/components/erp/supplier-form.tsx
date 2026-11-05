"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Checkbox, Field, Input, Textarea } from "@/components/ui/field";
import { useT } from "@/i18n/client";
import { api } from "@/lib/api-client";
import { useAction } from "./use-action";

export type SupplierInitial = {
  id: string;
  version: number;
  code: string;
  name: string;
  nameAr: string | null;
  contactPerson: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  taxNumber: string | null;
  notes: string | null;
  isActive: boolean;
};

const blank = { code: "", name: "", nameAr: "", contactPerson: "", phone: "", email: "", address: "", taxNumber: "", notes: "", isActive: true };

function Fields({ v, setV, errors, creating }: { v: typeof blank; setV: (v: typeof blank) => void; errors: Record<string, string>; creating: boolean }) {
  const t = useT();
  const set = (k: keyof typeof blank) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setV({ ...v, [k]: e.target.value });
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <Field label={t("suppliers.name")} required error={errors.name}>
        {(p) => <Input {...p} value={v.name} onChange={set("name")} maxLength={200} dir="auto" autoFocus={creating} />}
      </Field>
      <Field label={t("suppliers.nameAr")} error={errors.nameAr}>
        {(p) => <Input {...p} value={v.nameAr} onChange={set("nameAr")} maxLength={200} dir="rtl" />}
      </Field>
      <Field label={t("suppliers.code")} hint={creating ? t("suppliers.codeHint") : undefined} error={errors.code}>
        {(p) => <Input {...p} value={v.code} onChange={set("code")} maxLength={20} dir="ltr" className="font-mono" placeholder={creating ? "SUP-00001" : undefined} />}
      </Field>
      <Field label={t("suppliers.contactPerson")} error={errors.contactPerson}>
        {(p) => <Input {...p} value={v.contactPerson} onChange={set("contactPerson")} maxLength={120} dir="auto" />}
      </Field>
      <Field label={t("suppliers.phone")} error={errors.phone}>
        {(p) => <Input {...p} value={v.phone} onChange={set("phone")} type="tel" inputMode="tel" dir="ltr" />}
      </Field>
      <Field label={t("suppliers.email")} error={errors.email}>
        {(p) => <Input {...p} value={v.email} onChange={set("email")} type="email" dir="ltr" />}
      </Field>
      <Field label={t("suppliers.taxNumber")} error={errors.taxNumber}>
        {(p) => <Input {...p} value={v.taxNumber} onChange={set("taxNumber")} dir="ltr" />}
      </Field>
      <Field label={t("suppliers.address")} error={errors.address}>
        {(p) => <Input {...p} value={v.address} onChange={set("address")} dir="auto" />}
      </Field>
      <Field label={t("suppliers.notes")} error={errors.notes} className="sm:col-span-2">
        {(p) => <Textarea {...p} value={v.notes} onChange={set("notes")} rows={2} dir="auto" />}
      </Field>
      {!creating && <Checkbox label={t("suppliers.active")} checked={v.isActive} onChange={(e) => setV({ ...v, isActive: e.target.checked })} />}
    </div>
  );
}

/** "New supplier" button with its dialog (supplier list). */
export function NewSupplierButton() {
  const t = useT();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [v, setV] = useState(blank);
  const { busy, errors, run } = useAction();
  async function save(another: boolean) {
    const r = await run(() => api<{ supplier: { id: string } }>("/api/suppliers", { method: "POST", body: v }), () => t("suppliers.created"));
    if (!r) return;
    setV(blank);
    if (!another) {
      setOpen(false);
      router.push(`/suppliers/${r.supplier.id}`);
    }
  }
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" /> {t("suppliers.new")}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={t("suppliers.new")}
        size="lg"
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button variant="outline" loading={busy} onClick={() => void save(true)}>
              {t("forms.saveAndAddAnother")}
            </Button>
            <Button loading={busy} onClick={() => void save(false)}>
              {t("common.save")}
            </Button>
          </>
        }
      >
        <Fields v={v} setV={setV} errors={errors} creating />
      </Dialog>
    </>
  );
}

/** Edit a supplier (supplier page). */
export function SupplierForm({ initial }: { initial: SupplierInitial }) {
  const t = useT();
  const [v, setV] = useState({
    code: initial.code,
    name: initial.name,
    nameAr: initial.nameAr ?? "",
    contactPerson: initial.contactPerson ?? "",
    phone: initial.phone ?? "",
    email: initial.email ?? "",
    address: initial.address ?? "",
    taxNumber: initial.taxNumber ?? "",
    notes: initial.notes ?? "",
    isActive: initial.isActive,
  });
  const { busy, errors, run } = useAction();
  return (
    <Card>
      <CardHeader title={t("suppliers.edit")} />
      <form
        className="space-y-4 p-5"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => api(`/api/suppliers/${initial.id}`, { method: "PATCH", body: { ...v, version: initial.version } }), () => t("suppliers.saved"));
        }}
      >
        <Fields v={v} setV={setV} errors={errors} creating={false} />
        <div className="flex justify-end">
          <Button type="submit" loading={busy}>
            {t("common.saveChanges")}
          </Button>
        </div>
      </form>
    </Card>
  );
}
