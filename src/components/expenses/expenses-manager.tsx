"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Banknote, ImagePlus, Receipt, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/field";
import { EmptyState } from "@/components/ui/misc";
import { useT } from "@/i18n/client";
import { api, apiUpload, ApiError } from "@/lib/api-client";
import { money } from "@/lib/constants";
import { formatKey } from "@/lib/time";
import { preparePhoto } from "@/lib/image";
import { cn } from "@/lib/utils";
import type { ExpenseDTO, ExpenseSummary } from "@/server/services/expenses";

type Data = { month: string; items: ExpenseDTO[]; summary: ExpenseSummary[]; canPay: boolean; total: number; pending: number };
type VisitOption = { id: string; label: string };

const statusTone: Record<string, string> = {
  PENDING: "bg-warning-soft text-warning",
  PAID: "bg-success-soft text-success",
  CANCELLED: "bg-surface-muted text-fg-subtle line-through",
};

/** Transport expenses: technicians and the driver add theirs, the accountant pays them per person and month. */
export function ExpensesManager({ data, visits, canRecord }: { data: Data; visits: VisitOption[]; canRecord: boolean }) {
  const t = useT();
  const router = useRouter();
  const L = t.locale;
  const [amount, setAmount] = useState("");
  const [visit, setVisit] = useState("");
  const [note, setNote] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [paying, setPaying] = useState<ExpenseSummary | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const receiptFor = useRef<string | null>(null);
  const receiptInput = useRef<HTMLInputElement>(null);

  function failed(e: unknown) {
    const err = e instanceof ApiError ? e : new ApiError(t("common.couldNotSave"), 0, "UNKNOWN");
    setErrors(err.fieldErrors);
    toast.error(err.message);
  }

  async function uploadReceipt(id: string, f: File) {
    let blob: Blob;
    try {
      blob = await preparePhoto(f);
    } catch {
      toast.error(t("attachments.errors.read"));
      return false;
    }
    await apiUpload(`/api/expenses/${id}/receipt`, blob);
    return true;
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy("add");
    setErrors({});
    try {
      const { expense } = await api<{ expense: ExpenseDTO }>("/api/expenses", { method: "POST", body: { amount, appointmentId: visit || null, note } });
      if (file) await uploadReceipt(expense.id, file);
      toast.success(t("expenses.added"));
      setAmount("");
      setVisit("");
      setNote("");
      setFile(null);
      if (fileRef.current) fileRef.current.value = "";
      router.refresh();
    } catch (err) {
      failed(err);
    } finally {
      setBusy(null);
    }
  }

  async function act(id: string, fn: () => Promise<unknown>, done: string) {
    setBusy(id);
    try {
      await fn();
      toast.success(done);
      router.refresh();
    } catch (err) {
      failed(err);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      {canRecord && (
        <Card>
          <CardHeader title={t("expenses.addTitle")} description={t("expenses.addText")} icon={<Receipt className="h-4 w-4" />} />
          <form onSubmit={add} className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-2" noValidate>
            <Field label={t("expenses.amount")} required error={errors.amount}>
              {(p) => <Input {...p} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}
            </Field>
            <Field label={t("expenses.visit")} error={errors.appointmentId}>
              {(p) => (
                <Select {...p} value={visit} onChange={(e) => setVisit(e.target.value)}>
                  <option value="">{t("expenses.noVisit")}</option>
                  {visits.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={t("expenses.note")} error={errors.note}>
              {(p) => <Input {...p} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />}
            </Field>
            <Field label={t("expenses.receipt")} hint={t("expenses.receiptHint")}>
              {(p) => <Input {...p} ref={fileRef} type="file" accept="image/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />}
            </Field>
            <div className="sm:col-span-2">
              <Button type="submit" loading={busy === "add"}>
                {t("expenses.add")}
              </Button>
            </div>
          </form>
        </Card>
      )}

      {data.canPay && (
        <Card>
          <CardHeader title={t("expenses.byPerson")} description={t("expenses.totals", { total: money(data.total, L), pending: money(data.pending, L) })} icon={<Banknote className="h-4 w-4" />} />
          {data.summary.length === 0 ? (
            <EmptyState title={t("expenses.none")} />
          ) : (
            <ul className="divide-y divide-line">
              {data.summary.map((s) => (
                <li key={s.user.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                  <span>
                    <span className="block font-medium text-fg">{s.user.name}</span>
                    <span className="text-sm text-fg-muted">{t("expenses.personLine", { count: s.count, total: money(s.total, L), pending: money(s.pending, L) })}</span>
                  </span>
                  <Button size="sm" disabled={!s.pending || busy !== null} onClick={() => setPaying(s)}>
                    {t("expenses.pay")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      <Card>
        <CardHeader title={data.canPay ? t("expenses.all") : t("expenses.mine")} />
        {data.items.length === 0 ? (
          <EmptyState title={t("expenses.none")} />
        ) : (
          <ul className="divide-y divide-line">
            {data.items.map((e) => (
              <li key={e.id} className="flex flex-wrap items-start justify-between gap-3 px-5 py-3">
                <div className="min-w-0 space-y-0.5">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold tabular-nums text-fg">{money(e.amount, L)}</span>
                    <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", statusTone[e.status])}>{t.dyn(`expenses.status.${e.status}`)}</span>
                    <span className="text-sm text-fg-muted">{formatKey(e.day, { weekday: "short", day: "numeric", month: "short" }, L)}</span>
                    {data.canPay && <span className="text-sm text-fg">{e.user.name}</span>}
                  </p>
                  {e.appointment && (
                    <p className="text-sm text-fg-muted">
                      {e.appointment.customerName} · <bdi className="font-mono text-xs">{e.appointment.code}</bdi>
                    </p>
                  )}
                  {e.note && (
                    <p dir="auto" className="text-start text-sm text-fg-muted">
                      {e.note}
                    </p>
                  )}
                  {e.paidBy && e.paidAt && <p className="text-xs text-fg-subtle">{t("expenses.paidBy", { name: e.paidBy.name })}</p>}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {e.hasReceipt && (
                    <a href={`/api/expenses/${e.id}/receipt`} target="_blank" rel="noopener" className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-2.5 text-xs font-medium text-fg hover:bg-surface-muted">
                      <Receipt className="h-3.5 w-3.5" /> {t("expenses.viewReceipt")}
                    </a>
                  )}
                  {e.canAddReceipt && (
                    <Button
                      size="sm"
                      variant="outline"
                      loading={busy === `r:${e.id}`}
                      disabled={busy !== null}
                      onClick={() => {
                        receiptFor.current = e.id;
                        receiptInput.current?.click();
                      }}
                    >
                      <ImagePlus className="h-4 w-4" /> {t("expenses.addReceipt")}
                    </Button>
                  )}
                  {e.canCancel && (
                    <Button size="sm" variant="ghost" loading={busy === e.id} disabled={busy !== null} onClick={() => act(e.id, () => api(`/api/expenses/${e.id}`, { method: "DELETE" }), t("expenses.cancelled"))}>
                      <XCircle className="h-4 w-4" /> {t("expenses.cancel")}
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <input
        ref={receiptInput}
        type="file"
        accept="image/*"
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={async (ev) => {
          const f = ev.target.files?.[0];
          ev.target.value = "";
          const id = receiptFor.current;
          if (!f || !id) return;
          setBusy(`r:${id}`);
          try {
            if (await uploadReceipt(id, f)) {
              toast.success(t("attachments.uploaded"));
              router.refresh();
            }
          } catch (err) {
            failed(err);
          } finally {
            setBusy(null);
          }
        }}
      />
      <Dialog
        open={paying !== null}
        onClose={() => setPaying(null)}
        title={t("expenses.payTitle")}
        description={paying ? t("expenses.payText", { name: paying.user.name, amount: money(paying.pending, L) }) : undefined}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setPaying(null)} disabled={busy !== null}>
              {t("common.cancel")}
            </Button>
            <Button
              loading={busy === "pay"}
              onClick={async () => {
                if (!paying) return;
                setBusy("pay");
                try {
                  await api("/api/expenses/pay", { method: "POST", body: { userId: paying.user.id, month: data.month } });
                  toast.success(t("expenses.paid"));
                  setPaying(null);
                  router.refresh();
                } catch (err) {
                  failed(err);
                } finally {
                  setBusy(null);
                }
              }}
            >
              {t("expenses.pay")}
            </Button>
          </>
        }
      >
        {null}
      </Dialog>
    </div>
  );
}
