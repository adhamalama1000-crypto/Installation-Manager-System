"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { Alert, Badge } from "@/components/ui/misc";
import { useT } from "@/i18n/client";
import { api, ApiError } from "@/lib/api-client";
import { ROLES } from "@/lib/constants";
import type { DataScope } from "@/lib/permission-registry";
import { PermissionMatrix } from "./permission-matrix";

export type RoleEditorProps = {
  role: {
    id: string | null;
    name: string;
    nameAr: string | null;
    description: string | null;
    baseRole: string;
    isActive: boolean;
    version: number;
    permissions: string[];
    scopes: Record<string, DataScope>;
    baseDefaults: string[];
    baseScopes: Record<string, DataScope>;
    assignable: string[];
    members: { id: string; name: string; isActive: boolean }[];
  };
};

/** Name, base role and the permission matrix of a custom role. The server re-checks everything. */
export function RoleEditor({ role }: RoleEditorProps) {
  const t = useT();
  const router = useRouter();
  const [name, setName] = useState(role.name);
  const [nameAr, setNameAr] = useState(role.nameAr ?? "");
  const [description, setDescription] = useState(role.description ?? "");
  const [isActive, setIsActive] = useState(role.isActive);
  const [perms, setPerms] = useState<Set<string>>(() => new Set(role.permissions));
  const [scopes, setScopes] = useState<Record<string, string>>(() => ({ ...role.scopes }));
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const assignable = useMemo(() => new Set(role.assignable), [role.assignable]);
  const defaults = useMemo(() => new Set(role.baseDefaults), [role.baseDefaults]);

  async function save() {
    setBusy(true);
    setErrors({});
    const body = { name, nameAr, description, permissions: [...perms], scopes, isActive, reason, ...(role.id ? { version: role.version } : { baseRole: role.baseRole }) };
    try {
      if (role.id) {
        const r = await api<{ changed: boolean }>(`/api/access-roles/${role.id}`, { method: "PUT", body });
        toast.success(r.changed ? t("accessRoles.saved") : t("access.noChange"));
        router.refresh();
      } else {
        const r = await api<{ id: string }>("/api/access-roles", { method: "POST", body });
        toast.success(t("accessRoles.created"));
        router.push(`/users/roles/${r.id}`);
      }
    } catch (e) {
      if (e instanceof ApiError) {
        setErrors(e.fieldErrors ?? {});
        toast.error(e.message);
      } else toast.error(t("common.couldNotSave"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <div className="grid grid-cols-1 gap-4 p-5 md:grid-cols-2">
          <Field label={t("accessRoles.name")} error={t.msg(errors.name)} required>
            {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} dir="auto" />}
          </Field>
          <Field label={t("accessRoles.nameAr")}>{(p) => <Input {...p} value={nameAr} onChange={(e) => setNameAr(e.target.value)} maxLength={80} dir="rtl" />}</Field>
          <Field label={t("accessRoles.baseRole")} hint={t(role.id ? "accessRoles.baseRoleFixedHint" : "accessRoles.baseRoleHint")} error={t.msg(errors.baseRole)}>
            {(p) => (
              <Select {...p} value={role.baseRole} disabled={!!role.id} onChange={(e) => router.replace(`/users/roles/new?base=${e.target.value}`)}>
                {ROLES.filter((r) => r !== "ADMIN").map((r) => (
                  <option key={r} value={r}>
                    {t.dyn(`enums.role.${r}`, undefined, r)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {role.id && (
            <Field label={t("accessRoles.status")} error={t.msg(errors.isActive)}>
              {(p) => (
                <Select {...p} value={isActive ? "1" : "0"} onChange={(e) => setIsActive(e.target.value === "1")}>
                  <option value="1">{t("common.active")}</option>
                  <option value="0">{t("common.inactive")}</option>
                </Select>
              )}
            </Field>
          )}
          <Field label={t("accessRoles.description")} className="md:col-span-2">
            {(p) => <Textarea {...p} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} rows={2} dir="auto" />}
          </Field>
        </div>
      </Card>

      {role.baseRole === "VIEWER" && <Alert tone="info">{t("access.viewerNote")}</Alert>}
      {errors.permissions && <Alert tone="danger">{t.msg(errors.permissions)}</Alert>}

      <Card className="overflow-hidden">
        <CardHeader title={t("accessRoles.matrixTitle")} description={t("accessRoles.matrixText")} />
        <PermissionMatrix
          ariaLabel={t("accessRoles.matrixTitle")}
          perms={perms}
          setPerms={setPerms}
          scopes={scopes}
          setScopes={setScopes}
          assignable={assignable}
          defaults={defaults}
          defaultScopes={role.baseScopes}
          locked={false}
          showChanged
        />
        <div className="flex flex-col gap-3 border-t border-line p-4 md:flex-row md:items-end">
          <Field label={t("access.reason")} className="min-w-0 flex-1">
            {(p) => <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} dir="auto" />}
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            {role.id && role.members.length > 0 && <Badge className="border-warning/40 bg-warning-soft text-fg">{t("accessRoles.appliesTo", { count: role.members.length })}</Badge>}
            <Button loading={busy} onClick={() => void save()}>
              <Save className="h-4 w-4" /> {role.id ? t("accessRoles.save") : t("accessRoles.create")}
            </Button>
          </div>
        </div>
      </Card>

      {role.id && (
        <Card>
          <CardHeader title={t("accessRoles.membersTitle")} description={t("accessRoles.membersText")} />
          {role.members.length === 0 ? (
            <p className="px-5 pb-5 text-sm text-fg-muted">{t("accessRoles.noMembers")}</p>
          ) : (
            <ul className="flex flex-wrap gap-2 px-5 pb-5">
              {role.members.map((m) => (
                <li key={m.id}>
                  <Link href={`/users/${m.id}/access`} className="inline-flex">
                    <Badge className={m.isActive ? "" : "line-through"}>{m.name}</Badge>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}
