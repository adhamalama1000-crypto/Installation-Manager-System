"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useI18n } from "@/i18n/client";
import { api, ApiError } from "@/lib/api-client";
import { colorOrFallback, readableTextColor } from "@/lib/colors";
import { Button } from "@/components/ui/button";

type Person = { id: string; name: string; color: string | null; isActive: boolean; role: string };

export function SalesColors({ people }: { people: Person[] }) {
  const { t } = useI18n();
  const router = useRouter();
  const [colors, setColors] = useState<Record<string, string>>(Object.fromEntries(people.map((p) => [p.id, colorOrFallback(p.color)])));
  const [saving, setSaving] = useState<string | null>(null);

  async function save(p: Person) {
    setSaving(p.id);
    try {
      await api(`/api/users/${p.id}`, { method: "PATCH", body: { color: colors[p.id] } });
      toast.success(t("set.colourSaved", { name: p.name }));
      router.refresh();
    } catch (e) {
      toast.error((e as ApiError).message);
    } finally {
      setSaving(null);
    }
  }

  if (!people.length) return <p className="px-5 py-6 text-sm text-fg-muted">{t("set.noSales")}</p>;
  return (
    <ul className="divide-y divide-line">
      {people.map((p) => {
        const c = colors[p.id]!;
        const changed = c.toUpperCase() !== colorOrFallback(p.color).toUpperCase();
        return (
          <li key={p.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
            <input
              type="color"
              value={c}
              onChange={(e) => setColors((s) => ({ ...s, [p.id]: e.target.value.toUpperCase() }))}
              className="h-9 w-12 cursor-pointer rounded border border-line"
              aria-label={t("set.colourFor", { name: p.name })}
            />
            <span className="min-w-0 flex-1 text-sm font-medium">
              {p.name} {!p.isActive && <span className="text-xs font-normal text-fg-subtle">{t("common.inactiveParen")}</span>}
              {p.role === "ADMIN" && <span className="text-xs font-normal text-fg-subtle"> {t("set.adminTag")}</span>}
            </span>
            <span className="rounded-md px-2 py-1 text-xs font-semibold" style={{ backgroundColor: c, color: readableTextColor(c) }}>
              {t("set.preview")}
            </span>
            <Button size="sm" variant={changed ? "primary" : "outline"} disabled={!changed} loading={saving === p.id} onClick={() => save(p)}>
              {t("common.save")}
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
