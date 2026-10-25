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
import { Alert, Badge, EmptyState } from "@/components/ui/misc";
import { api, ApiError } from "@/lib/api-client";
import { colorOrFallback } from "@/lib/colors";
import { ROLES, ROLE_LABELS, SALES_COLOR_SUGGESTIONS } from "@/lib/constants";
import { DEFAULT_VIEWER_PERMISSIONS, VIEWER_GRANTABLE, VIEWER_PERMISSION_LABELS } from "@/lib/permissions";
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

const ROLE_HELP: Record<Role, string> = {
  ADMIN: "Full access including users, settings and the audit log.",
  SALES: "Sees all appointments; creates, edits, reschedules and cancels bookings.",
  TECHNICIAN: "Read-only access to their own assigned appointments. Appears in technician selection automatically.",
  VIEWER: "Read-only. You choose exactly what they can see below.",
};

function ColorPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
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
            aria-label={`Use colour ${c}`}
            aria-pressed={value.toUpperCase() === c}
          />
        ))}
      </div>
      <div className="flex items-center gap-2">
        <input type="color" value={/^#[0-9a-f]{6}$/i.test(value) ? value : "#E55823"} onChange={(e) => onChange(e.target.value.toUpperCase())} className="h-9 w-12 cursor-pointer rounded border border-line bg-surface" aria-label="Custom colour" />
        <Input value={value} onChange={(e) => onChange(e.target.value)} className="w-32 font-mono" aria-label="Hex colour" placeholder="#E55823" />
      </div>
    </div>
  );
}

export function UsersManager({ users, currentUserId }: { users: UserDTO[]; currentUserId: string }) {
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
        toast.success(`${res.user.name} added`);
        if (res.invite) setLink({ name: res.user.name, ...res.invite });
      } else if (editing) {
        await api(`/api/users/${editing.id}`, { method: "PATCH", body });
        toast.success("User updated");
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

  const th = "px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-fg-subtle";
  const showColor = draft && (draft.role === "SALES" || draft.role === "ADMIN" || draft.color);

  return (
    <>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-1 flex-col gap-2 sm:flex-row">
          <div className="relative sm:w-72">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search users" aria-label="Search users" className="pl-9" />
          </div>
          <Select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)} aria-label="Filter by role" className="sm:w-44">
            <option value="">All roles</option>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </Select>
        </div>
        <Button onClick={openCreate}>
          <Plus className="h-4 w-4" /> Add user
        </Button>
      </div>

      <Card className="overflow-hidden">
        {filtered.length === 0 ? (
          <EmptyState title="No users match" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="border-b border-line bg-surface-muted/60">
                <tr>
                  <th className={th}>Name</th>
                  <th className={th}>Email</th>
                  <th className={th}>Role</th>
                  <th className={th}>Status</th>
                  <th className={th}>Created</th>
                  <th className={cn(th, "text-right")}>Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {filtered.map((u) => (
                  <tr key={u.id} className={cn(!u.isActive && "opacity-60")}>
                    <td className="px-4 py-3">
                      <span className="flex items-center gap-2 font-medium text-fg">
                        {(u.role === "SALES" || u.color) && <span className="h-3 w-3 rounded-full ring-1 ring-black/10" style={{ backgroundColor: colorOrFallback(u.color) }} aria-hidden />}
                        {u.name}
                        {u.id === currentUserId && <Badge>You</Badge>}
                      </span>
                      {u.phone && <span className="block text-xs text-fg-subtle">{u.phone}</span>}
                    </td>
                    <td className="px-4 py-3 text-fg-muted">{u.email}</td>
                    <td className="px-4 py-3">
                      <Badge className={cn(u.role === "ADMIN" && "border-brand/40 bg-brand-soft text-brand-text")}>{ROLE_LABELS[u.role]}</Badge>
                    </td>
                    <td className="px-4 py-3">
                      {u.isActive ? <span className="text-success">Active</span> : <span className="text-fg-subtle">Inactive</span>}
                      {!u.hasPassword && <span className="block text-xs text-warning">Invitation pending</span>}
                    </td>
                    <td className="px-4 py-3 text-fg-muted">{new Date(u.createdAt).toLocaleDateString("en-GB")}</td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => openEdit(u)}>
                          <Pencil className="h-3.5 w-3.5" /> Edit
                        </Button>
                        {u.isActive && (
                          <Button variant="ghost" size="sm" onClick={() => passwordLink(u)} title={u.hasPassword ? "Create a password reset link" : "Create a new invitation link"}>
                            <KeyRound className="h-3.5 w-3.5" /> {u.hasPassword ? "Reset link" : "Invite link"}
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
        title={creating ? "Add user" : `Edit ${editing?.name ?? "user"}`}
        size="lg"
        footer={
          <>
            <Button variant="outline" onClick={close} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={save} loading={saving}>
              {creating ? "Create user" : "Save changes"}
            </Button>
          </>
        }
      >
        {draft && (
          <div className="space-y-5">
            {errors._form && <Alert tone="danger">{errors._form}</Alert>}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Full name" required error={errors.name}>
                {(p) => <Input {...p} value={draft.name} onChange={(e) => upd({ name: e.target.value })} />}
              </Field>
              <Field label="Email (login)" required error={errors.email}>
                {(p) => <Input {...p} type="email" value={draft.email} onChange={(e) => upd({ email: e.target.value })} />}
              </Field>
              <Field label="Phone" error={errors.phone} hint="Optional">
                {(p) => <Input {...p} type="tel" value={draft.phone} onChange={(e) => upd({ phone: e.target.value })} />}
              </Field>
              <Field label="Role" required error={errors.role} hint={ROLE_HELP[draft.role]}>
                {(p) => (
                  <Select {...p} value={draft.role} onChange={(e) => upd({ role: e.target.value as Role })} disabled={editing?.id === currentUserId}>
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABELS[r]}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
            {showColor && (
              <div>
                <p className="mb-2 text-sm font-medium">Calendar colour</p>
                <p className="mb-3 text-xs text-fg-subtle">Appointments booked by this person use this colour everywhere. Leave empty for Sales to get the next free colour.</p>
                <ColorPicker value={draft.color} onChange={(c) => upd({ color: c })} />
                {errors.color && <p className="mt-1 text-xs text-danger">{errors.color}</p>}
              </div>
            )}
            {draft.role === "VIEWER" && (
              <div>
                <p className="mb-1 text-sm font-medium">What this viewer can see</p>
                <div className="grid gap-1 sm:grid-cols-2">
                  {VIEWER_GRANTABLE.map((perm) => (
                    <Checkbox
                      key={perm}
                      label={VIEWER_PERMISSION_LABELS[perm]!.label}
                      description={VIEWER_PERMISSION_LABELS[perm]!.description}
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
              <Field label="Initial password" error={errors.password} hint="Optional. Leave empty to generate a one-time invitation link instead (recommended).">
                {(p) => <Input {...p} type="password" autoComplete="new-password" value={draft.password} onChange={(e) => upd({ password: e.target.value })} />}
              </Field>
            ) : (
              <Checkbox
                label="Account active"
                description={editing?.id === currentUserId ? "You cannot deactivate your own account." : "Inactive users cannot sign in or be assigned; their history is kept."}
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
        title="One-time password link"
        description={link ? `Send this link to ${link.name} through a secure channel.` : undefined}
        footer={<Button onClick={() => setLink(null)}>Done</Button>}
      >
        {link && (
          <div className="space-y-3">
            <div className="flex gap-2">
              <Input readOnly value={link.url} className="font-mono text-xs" onFocus={(e) => e.target.select()} aria-label="Password link" />
              <Button
                variant="outline"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(link.url);
                    toast.success("Link copied");
                  } catch {
                    toast.error("Copy failed - select the link and copy it manually.");
                  }
                }}
              >
                <Copy className="h-4 w-4" /> Copy
              </Button>
            </div>
            <p className="text-xs text-fg-subtle">
              Valid until {new Date(link.expiresAt).toLocaleString("en-GB")} and usable once. Any previous link for this user no longer works. Email delivery is not configured, so the link is shown here only.
            </p>
          </div>
        )}
      </Dialog>
    </>
  );
}
