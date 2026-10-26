"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Copy, KeyRound, Pencil, Plus, Search } from "lucide-react";
import type { Role } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Checkbox, Field, Input, Select } from "@/components/ui/field";
import { Ltr } from "@/components/ui/ltr";
import { Alert, Badge, EmptyState } from "@/components/ui/misc";
import { useI18n } from "@/i18n/client";
import type { MessageKey } from "@/i18n/translate";
import { api, ApiError } from "@/lib/api-client";
import { colorOrFallback } from "@/lib/colors";
import { ROLES, SALES_COLOR_SUGGESTIONS } from "@/lib/constants";
import { DEFAULT_VIEWER_PERMISSIONS, VIEWER_GRANTABLE } from "@/lib/permissions";
import type { UserDTO } from "@/lib/types";
import { cn } from "@/lib/utils";

type Draft = {
  name: string;
  email: string;
  phone: string;
  role: Role;
  isActive: boolean;
  color: string;
  viewerPermissions: string[];
  password: string;
};

function ColorPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useI18n();
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {SALES_COLOR_SUGGESTIONS.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => onChange(c)}
            className={cn("h-8 w-8 rounded-full ring-offset-2 ring-offset-surface", value.toUpperCase() === c ? "ring-2 ring-fg" : "ring-1 ring-black/10")}
            style={{ backgroundColor: c }}
            aria-label={t("users.useColour", { color: c })}
            aria-pressed={value.toUpperCase() === c}
          />
        ))}
      </div>
      <div className="flex items-center gap-2">
        <input type="color" value={/^#[0-9a-f]{6}$/i.test(value) ? value : "#E55823"} onChange={(e) => onChange(e.target.value.toUpperCase())} className="h-9 w-12 cursor-pointer rounded border border-line bg-surface" aria-label={t("users.customColour")} />
        <Input value={value} dir="ltr" onChange={(e) => onChange(e.target.value)} className="w-32 font-mono" aria-label={t("users.hexColour")} placeholder="#E55823" />
      </div>
    </div>
  );
}

export function UsersManager({ users, currentUserId }: { users: UserDTO[]; currentUserId: string }) {
  const { t, f, label } = useI18n();
  const router = useRouter();
  const [editing, setEditing] = useState<UserDTO | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [link, setLink] = useState<{ name: string; url: string; expiresAt: string } | null>(null);
  const [q, setQ] = useState("");
  const [roleFilter, setRoleFilter] = useState<string>("");

  const filtered = useMemo(
    () =>
      users.filter(
        (u) =>
          (!roleFilter || u.role === roleFilter) &&
          (!q || u.name.toLowerCase().includes(q.toLowerCase()) || u.email.includes(q.toLowerCase())),
      ),
    [users, q, roleFilter],
  );

  function openCreate() {
    setErrors({});
    setEditing(null);
    setDraft({ name: "", email: "", phone: "", role: "SALES", isActive: true, color: "", viewerPermissions: [...DEFAULT_VIEWER_PERMISSIONS], password: "" });
    setCreating(true);
  }
  function openEdit(u: UserDTO) {
    setErrors({});
    setCreating(false);
    setEditing(u);
    setDraft({ name: u.name, email: u.email, phone: u.phone ?? "", role: u.role, isActive: u.isActive, color: u.color ?? "", viewerPermissions: u.viewerPermissions, password: "" });
  }
  const close = () => {
    setCreating(false);
    setEditing(null);
    setDraft(null);
  };
  const upd = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  async function save() {
    if (!draft) return;
    setSaving(true);
    setErrors({});
    try {
      const body = {
        name: draft.name,
        email: draft.email,
        phone: draft.phone,
        role: draft.role,
        color: draft.color || null,
        viewerPermissions: draft.role === "VIEWER" ? draft.viewerPermissions : undefined,
        ...(creating ? { password: draft.password } : { isActive: draft.isActive }),
      };
      if (creating) {
        const res = await api<{ user: UserDTO; invite: { url: string; expiresAt: string } | null }>("/api/users", { method: "POST", body });
        toast.success(t("users.added", { name: res.user.name }));
        if (res.invite) setLink({ name: res.user.name, ...res.invite });
      } else if (editing) {
        await api(`/api/users/${editing.id}`, { method: "PATCH", body });
        toast.success(t("users.updated"));
      }
      close();
      router.refresh();
    } catch (e) {
      const err = e as ApiError;
      setErrors(err.fieldErrors ?? {});
      if (!Object.keys(err.fieldErrors ?? {}).length) setErrors({ _form: err.message });
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function passwordLink(u: UserDTO) {
    try {
      const res = await api<{ link: { url: string; expiresAt: string } }>(`/api/users/${u.id}/password-link`, { method: "POST", body: {} });
      setLink({ name: u.name, ...res.link });
    } catch (e) {
      toast.error((e as ApiError).message);
    }
  }

  const th = "px-4 py-3 text-start text-xs font-semibold uppercase tracking-wide text-fg-subtle";
  const showColor = draft && (draft.role === "SALES" || draft.role === "ADMIN" || draft.color);

  return (
    <>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-1 flex-col gap-2 sm:flex-row">
          <div className="relative sm:w-72">
            <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("users.search")} aria-label={t("users.search")} className="ps-9" />
          </div>
          <Select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)} aria-label={t("users.filterRole")} className="sm:w-44">
            <option value="">{t("users.allRoles")}</option>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {label("role", r)}
              </option>
            ))}
          </Select>
        </div>
        <Button onClick={openCreate}>
          <Plus className="h-4 w-4" /> {t("users.add")}
        </Button>
      </div>

      <Card className="overflow-hidden">
        {filtered.length === 0 ? (
          <EmptyState title={t("users.noMatch")} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="border-b border-line bg-surface-muted/60">
                <tr>
                  <th className={th}>{t("users.colName")}</th>
                  <th className={th}>{t("users.colEmail")}</th>
                  <th className={th}>{t("users.colRole")}</th>
                  <th className={th}>{t("users.colStatus")}</th>
                  <th className={th}>{t("users.colCreated")}</th>
                  <th className={cn(th, "text-end")}>{t("users.colActions")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {filtered.map((u) => (
                  <tr key={u.id} className={cn(!u.isActive && "opacity-60")}>
                    <td className="px-4 py-3">
                      <span className="flex items-center gap-2 font-medium text-fg">
                        {(u.role === "SALES" || u.color) && <span className="h-3 w-3 rounded-full ring-1 ring-black/10" style={{ backgroundColor: colorOrFallback(u.color) }} aria-hidden />}
                        {u.name}
                        {u.id === currentUserId && <Badge>{t("users.you")}</Badge>}
                      </span>
                      {u.phone && (
                        <span className="block text-xs text-fg-subtle">
                          <Ltr>{u.phone}</Ltr>
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-fg-muted">
                      <Ltr>{u.email}</Ltr>
                    </td>
                    <td className="px-4 py-3">
                      <Badge className={cn(u.role === "ADMIN" && "border-brand/40 bg-brand-soft text-brand-text")}>{label("role", u.role)}</Badge>
                    </td>
                    <td className="px-4 py-3">
                      {u.isActive ? <span className="text-success">{t("common.active")}</span> : <span className="text-fg-subtle">{t("common.inactive")}</span>}
                      {!u.hasPassword && <span className="block text-xs text-warning">{t("users.invitePending")}</span>}
                    </td>
                    <td className="px-4 py-3 text-fg-muted">{f.shortDate(u.createdAt)}</td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => openEdit(u)}>
                          <Pencil className="h-3.5 w-3.5" /> {t("common.edit")}
                        </Button>
                        {u.isActive && (
                          <Button variant="ghost" size="sm" onClick={() => passwordLink(u)} title={u.hasPassword ? t("users.resetTitle") : t("users.inviteTitle")}>
                            <KeyRound className="h-3.5 w-3.5" /> {u.hasPassword ? t("users.resetLink") : t("users.inviteLink")}
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Dialog
        open={Boolean(draft)}
        onClose={close}
        title={creating ? t("users.add") : t("users.editTitle", { name: editing?.name ?? "" })}
        size="lg"
        footer={
          <>
            <Button variant="outline" onClick={close} disabled={saving}>
              {t("common.cancel")}
            </Button>
            <Button onClick={save} loading={saving}>
              {creating ? t("users.create") : t("common.saveChanges")}
            </Button>
          </>
        }
      >
        {draft && (
          <div className="space-y-5">
            {errors._form && <Alert tone="danger">{errors._form}</Alert>}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("users.fullName")} required error={errors.name}>
                {(p) => <Input {...p} value={draft.name} onChange={(e) => upd({ name: e.target.value })} />}
              </Field>
              <Field label={t("users.emailLogin")} required error={errors.email}>
                {(p) => <Input {...p} type="email" dir="ltr" value={draft.email} onChange={(e) => upd({ email: e.target.value })} />}
              </Field>
              <Field label={t("users.phone")} error={errors.phone} hint={t("users.phoneHint")}>
                {(p) => <Input {...p} type="tel" dir="ltr" value={draft.phone} onChange={(e) => upd({ phone: e.target.value })} />}
              </Field>
              <Field label={t("users.role")} required error={errors.role} hint={t(`users.roleHelp.${draft.role}`)}>
                {(p) => (
                  <Select {...p} value={draft.role} onChange={(e) => upd({ role: e.target.value as Role })} disabled={editing?.id === currentUserId}>
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {label("role", r)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
            {showColor && (
              <div>
                <p className="mb-2 text-sm font-medium">{t("users.calendarColour")}</p>
                <p className="mb-3 text-xs text-fg-subtle">{t("users.colourHint")}</p>
                <ColorPicker value={draft.color} onChange={(c) => upd({ color: c })} />
                {errors.color && <p className="mt-1 text-xs text-danger">{errors.color}</p>}
              </div>
            )}
            {draft.role === "VIEWER" && (
              <div>
                <p className="mb-1 text-sm font-medium">{t("users.viewerSees")}</p>
                <div className="grid gap-1 sm:grid-cols-2">
                  {VIEWER_GRANTABLE.map((perm) => (
                    <Checkbox
                      key={perm}
                      label={t(`perm.${perm}.label` as MessageKey)}
                      description={t(`perm.${perm}.desc` as MessageKey)}
                      checked={draft.viewerPermissions.includes(perm)}
                      onChange={(e) =>
                        upd({ viewerPermissions: e.target.checked ? [...draft.viewerPermissions, perm] : draft.viewerPermissions.filter((x) => x !== perm) })
                      }
                    />
                  ))}
                </div>
              </div>
            )}
            {creating ? (
              <Field label={t("users.initialPassword")} error={errors.password} hint={t("users.initialPasswordHint")}>
                {(p) => <Input {...p} type="password" autoComplete="new-password" value={draft.password} onChange={(e) => upd({ password: e.target.value })} />}
              </Field>
            ) : (
              <Checkbox
                label={t("users.accountActive")}
                description={editing?.id === currentUserId ? t("users.cannotDeactivateSelf") : t("users.inactiveHint")}
                checked={draft.isActive}
                disabled={editing?.id === currentUserId}
                onChange={(e) => upd({ isActive: e.target.checked })}
              />
            )}
          </div>
        )}
      </Dialog>

      <Dialog
        open={Boolean(link)}
        onClose={() => setLink(null)}
        title={t("users.linkTitle")}
        description={link ? t("users.linkDesc", { name: link.name }) : undefined}
        footer={<Button onClick={() => setLink(null)}>{t("users.done")}</Button>}
      >
        {link && (
          <div className="space-y-3">
            <div className="flex gap-2">
              <Input readOnly dir="ltr" value={link.url} className="font-mono text-xs" onFocus={(e) => e.target.select()} aria-label={t("users.passwordLink")} />
              <Button
                variant="outline"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(link.url);
                    toast.success(t("users.linkCopied"));
                  } catch {
                    toast.error(t("users.copyFailed"));
                  }
                }}
              >
                <Copy className="h-4 w-4" /> {t("common.copy")}
              </Button>
            </div>
            <p className="text-xs text-fg-subtle">
              {t("users.linkValid", { date: f.dateTime(link.expiresAt) })}
            </p>
          </div>
        )}
      </Dialog>
    </>
  );
}
