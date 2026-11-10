"use client";

import { useState } from "react";
import { Plus, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Checkbox, Field, Input } from "@/components/ui/field";
import { Badge } from "@/components/ui/misc";
import { useAction } from "@/components/erp/use-action";
import { useT } from "@/i18n/client";
import { api } from "@/lib/api-client";

type Team = { id: string; name: string; nameAr: string | null; isActive: boolean; members: number };

/** Teams for the "team records" scope (Admin). Teams are deactivated, never deleted. */
export function TeamsManager({ teams }: { teams: Team[] }) {
  const t = useT();
  const [editing, setEditing] = useState<Team | "new" | null>(null);
  return (
    <Card className="mt-6">
      <CardHeader
        title={t("teams.title")}
        description={t("teams.text")}
        icon={<Users className="h-4 w-4" />}
        actions={
          <Button size="sm" variant="outline" onClick={() => setEditing("new")}>
            <Plus className="h-4 w-4" /> {t("teams.add")}
          </Button>
        }
      />
      {teams.length === 0 ? (
        <p className="px-5 pb-5 text-sm text-fg-muted">{t("teams.none")}</p>
      ) : (
        <ul className="divide-y divide-line border-t border-line" aria-label={t("teams.title")}>
          {teams.map((x) => (
            <li key={x.id} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
              <span className="font-medium text-fg" dir="auto">
                {t.locale === "ar" && x.nameAr ? x.nameAr : x.name}
              </span>
              <span className="text-xs text-fg-muted">{t("teams.members", { count: x.members })}</span>
              {!x.isActive && <Badge>{t("teams.inactive")}</Badge>}
              <Button size="sm" variant="ghost" className="ms-auto" onClick={() => setEditing(x)} aria-label={`${t("teams.edit")}: ${x.name}`}>
                {t("common.edit")}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {editing && <TeamDialog initial={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}

function TeamDialog({ initial, onClose }: { initial: Team | null; onClose: () => void }) {
  const t = useT();
  const { busy, errors, run } = useAction();
  const [v, setV] = useState({ name: initial?.name ?? "", nameAr: initial?.nameAr ?? "", isActive: initial?.isActive ?? true });
  async function save() {
    const r = await run(() => (initial ? api(`/api/teams/${initial.id}`, { method: "PATCH", body: v }) : api("/api/teams", { method: "POST", body: v })), () => t("teams.saved"));
    if (r) onClose();
  }
  return (
    <Dialog
      open
      onClose={onClose}
      title={initial ? t("teams.edit") : t("teams.add")}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button loading={busy} onClick={() => void save()}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label={t("teams.name")} required error={errors.name}>
          {(p) => <Input {...p} value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} maxLength={80} dir="auto" />}
        </Field>
        <Field label={t("teams.nameAr")} error={errors.nameAr}>
          {(p) => <Input {...p} value={v.nameAr} onChange={(e) => setV({ ...v, nameAr: e.target.value })} maxLength={80} dir="rtl" />}
        </Field>
        <Checkbox label={t("teams.active")} checked={v.isActive} onChange={(e) => setV({ ...v, isActive: e.target.checked })} />
      </div>
    </Dialog>
  );
}
