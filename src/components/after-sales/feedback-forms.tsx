"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { PhoneCall } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { useT } from "@/i18n/client";
import { api, ApiError } from "@/lib/api-client";
import { Stars } from "./stars";

function useSave() {
  const t = useT();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function save(path: string, method: "PUT" | "POST", body: unknown) {
    setBusy(true);
    try {
      await api(path, { method, body });
      toast.success(t("afterSales.saved"));
      router.refresh();
      return true;
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : t("common.couldNotSave"));
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { busy, save };
}

/** The customer's satisfaction (stars and their words), recorded after calling them. */
export function RatingForm({ appointmentId, rating, note }: { appointmentId: string; rating: number | null; note: string | null }) {
  const t = useT();
  const { busy, save } = useSave();
  const [stars, setStars] = useState<number | null>(rating);
  const [text, setText] = useState(note ?? "");
  const changed = stars !== rating || (text.trim() || null) !== (note ?? null);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Stars value={stars} onChange={setStars} label={t("afterSales.rating")} disabled={busy} />
      <Input
        aria-label={t("afterSales.ratingNote")}
        placeholder={t("afterSales.ratingNote")}
        value={text}
        maxLength={500}
        onChange={(e) => setText(e.target.value)}
        className="h-9 min-w-0 flex-1 basis-40"
      />
      <Button size="sm" disabled={!stars || !changed} loading={busy} onClick={() => save(`/api/appointments/${appointmentId}/rating`, "PUT", { rating: stars, note: text })}>
        {t("afterSales.save")}
      </Button>
      {rating !== null && (
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={async () => {
            if (await save(`/api/appointments/${appointmentId}/rating`, "PUT", { rating: null, note: null })) {
              setStars(null);
              setText("");
            }
          }}
        >
          {t("afterSales.clear")}
        </Button>
      )}
    </div>
  );
}

/** The head of installations' quality grade, saved on the click of a star. */
export function GradeForm({ appointmentId, grade }: { appointmentId: string; grade: number | null }) {
  const t = useT();
  const { busy, save } = useSave();
  const [stars, setStars] = useState<number | null>(grade);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Stars
        value={stars}
        label={t("afterSales.grade")}
        disabled={busy}
        onChange={async (n) => {
          const before = stars;
          setStars(n);
          if (!(await save(`/api/appointments/${appointmentId}/grade`, "PUT", { grade: n }))) setStars(before);
        }}
      />
      {grade !== null && (
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={async () => {
            if (await save(`/api/appointments/${appointmentId}/grade`, "PUT", { grade: null })) setStars(null);
          }}
        >
          {t("afterSales.clear")}
        </Button>
      )}
    </div>
  );
}

/** Records the 6- or 12-month maintenance reminder call. */
export function CallForm({ appointmentId, months }: { appointmentId: string; months: 6 | 12 }) {
  const t = useT();
  const { busy, save } = useSave();
  const [note, setNote] = useState("");
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input aria-label={t("afterSales.callNote")} placeholder={t("afterSales.callNote")} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} className="h-9 min-w-0 flex-1 basis-40" />
      <Button size="sm" variant="outline" loading={busy} onClick={() => save(`/api/appointments/${appointmentId}/maintenance-calls`, "POST", { milestone: months, note })}>
        <PhoneCall className="h-4 w-4" /> {t("afterSales.markCalled", { months })}
      </Button>
    </div>
  );
}
