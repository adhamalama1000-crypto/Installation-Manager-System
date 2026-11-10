"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Copy, LayoutTemplate, RotateCcw, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/field";
import { Alert, Badge } from "@/components/ui/misc";
import { useT } from "@/i18n/client";
import { api, ApiError } from "@/lib/api-client";
import { ACTION_KINDS, MODULES, levelOf, levelsOf, permissionsForLevel, type ActionKind, type DataScope, type Level, type ModuleAction, type ModuleDef } from "@/lib/permission-registry";
import { cn } from "@/lib/utils";

export type AccessProps = {
  user: { id: string; name: string; role: string; isActive: boolean; teamId: string | null };
  isSelf: boolean;
  isAdmin: boolean;
  roleDefaults: string[];
  grants: string[];
  denies: string[];
  effective: string[];
  assignable: string[];
  scopes: Record<string, DataScope>;
  defaultScopes: Record<string, DataScope>;
  templates: { id: string; permissions: string[]; scopes: Record<string, string> }[];
  people: { id: string; name: string; role: string; isActive: boolean }[];
  teams: { id: string; name: string; nameAr: string | null; isActive: boolean }[];
};

/** The matrix columns: the standard actions; named special actions go to "Other". */
const COLUMNS = ACTION_KINDS.filter((k) => k !== "special");

/**
 * Per-person permissions by module: a level (no access … full access, or custom), a checkbox per
 * action, and which records (own / assigned / team / all). The server re-checks everything; this
 * screen only helps to build the request.
 */
export function PermissionEditor(props: AccessProps) {
  const t = useT();
  const router = useRouter();
  const locked = props.isAdmin || props.isSelf;
  const [perms, setPerms] = useState<Set<string>>(() => new Set(props.effective));
  const [scopes, setScopes] = useState<Record<string, string>>(() => ({ ...props.scopes }));
  const [teamId, setTeamId] = useState<string>(props.user.teamId ?? "");
  const [reason, setReason] = useState("");
  const [template, setTemplate] = useState(props.templates[0]?.id ?? "");
  const [copyFrom, setCopyFrom] = useState(props.people[0]?.id ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const assignable = useMemo(() => new Set(props.assignable), [props.assignable]);
  const defaults = useMemo(() => new Set(props.roleDefaults), [props.roleDefaults]);
  const initial = useMemo(() => new Set(props.effective), [props.effective]);

  const label = (x: ModuleAction) => (x.label ? t.dyn(`permRegistry.special.${x.label}`) : t.dyn(`permRegistry.actions.${x.kind}`));
  const canToggle = (p: string) => !locked && (assignable.has(p) || perms.has(p));

  const changes = useMemo(() => {
    let n = 0;
    for (const p of new Set([...perms, ...initial])) if (perms.has(p) !== initial.has(p)) n++;
    for (const m of Object.keys(props.scopes)) if (scopes[m] !== props.scopes[m]) n++;
    if ((teamId || null) !== props.user.teamId) n++;
    return n;
  }, [perms, initial, scopes, props.scopes, teamId, props.user.teamId]);

  function toggle(p: string, on: boolean) {
    setPerms((s) => {
      const n = new Set(s);
      if (on) n.add(p);
      else n.delete(p);
      return n;
    });
  }

  function setLevel(m: ModuleDef, level: Level) {
    if (level === "custom") return;
    const want = new Set(permissionsForLevel(m, level));
    setPerms((s) => {
      const n = new Set(s);
      for (const x of m.actions) {
        if (want.has(x.permission) && (assignable.has(x.permission) || n.has(x.permission))) n.add(x.permission);
        else if (!want.has(x.permission)) n.delete(x.permission);
      }
      return n;
    });
  }

  async function send(body: Record<string, unknown>, key: string, confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(key);
    try {
      const r = await api<{ changed: boolean }>(`/api/users/${props.user.id}/access`, { method: "PUT", body: { ...body, reason } });
      toast.success(r.changed ? t("access.saved") : t("access.noChange"));
      setReason("");
      router.refresh();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : t("common.couldNotSave"));
    } finally {
      setBusy(null);
    }
  }

  const people = props.people.filter((p) => p.isActive);
  const teamName = (x: { name: string; nameAr: string | null }) => (t.locale === "ar" && x.nameAr ? x.nameAr : x.name);

  return (
    <div className="space-y-6">
      {props.isAdmin && <Alert tone="info">{t("access.adminNote")}</Alert>}
      {props.isSelf && !props.isAdmin && <Alert tone="warning">{t("access.selfNote")}</Alert>}
      {props.user.role === "VIEWER" && <Alert tone="info">{t("access.viewerNote")}</Alert>}

      {!locked && (
        <Card>
          <div className="grid grid-cols-1 gap-4 p-5 md:grid-cols-3">
            <Field label={t("access.team")}>
              {(p) => (
                <Select {...p} value={teamId} onChange={(e) => setTeamId(e.target.value)}>
                  <option value="">{t("access.noTeam")}</option>
                  {props.teams.filter((x) => x.isActive || x.id === props.user.teamId).map((x) => (
                    <option key={x.id} value={x.id}>
                      {teamName(x)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <div className="flex items-end gap-2">
              <Field label={t("access.templates")} className="min-w-0 flex-1">
                {(p) => (
                  <Select {...p} value={template} onChange={(e) => setTemplate(e.target.value)}>
                    {props.templates.map((x) => (
                      <option key={x.id} value={x.id}>
                        {t.dyn(`access.templateNames.${x.id}`)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Button variant="outline" loading={busy === "template"} onClick={() => void send({ mode: "template", template }, "template", t("access.templateConfirm"))}>
                <LayoutTemplate className="h-4 w-4" /> {t("access.applyTemplate")}
              </Button>
            </div>
            <div className="flex items-end gap-2">
              <Field label={t("access.copyFrom")} className="min-w-0 flex-1">
                {(p) => (
                  <Select {...p} value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}>
                    {people.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.name} · {t.dyn(`enums.role.${x.role}`, undefined, x.role)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Button
                variant="outline"
                disabled={!copyFrom}
                loading={busy === "copy"}
                onClick={() => void send({ mode: "copy", fromUserId: copyFrom }, "copy", t("access.copyConfirm", { name: people.find((x) => x.id === copyFrom)?.name ?? "" }))}
              >
                <Copy className="h-4 w-4" /> {t("access.copy")}
              </Button>
            </div>
          </div>
        </Card>
      )}

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-sm" aria-label={t("access.title", { name: props.user.name })}>
            <thead className="bg-surface-muted/60 text-xs text-fg-muted">
              <tr>
                <th className="px-3 py-2 text-start font-medium">{t("access.module")}</th>
                <th className="px-3 py-2 text-start font-medium">{t("access.level")}</th>
                {COLUMNS.map((k) => (
                  <th key={k} className="px-2 py-2 text-center font-medium">
                    {t.dyn(`permRegistry.actions.${k}`)}
                  </th>
                ))}
                <th className="px-3 py-2 text-start font-medium">{t("permRegistry.actions.special")}</th>
                <th className="px-3 py-2 text-start font-medium">{t("access.scope")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {MODULES.map((m) => {
                const level = levelOf(m, perms);
                const changed = m.actions.some((x) => perms.has(x.permission) !== defaults.has(x.permission)) || (m.scopes?.length ? scopes[m.id] !== props.defaultScopes[m.id] : false);
                const rowLocked = locked || !!m.adminOnly;
                const byKind = (k: ActionKind) => m.actions.filter((x) => x.kind === k);
                return (
                  <tr key={m.id} className="align-top" data-module={m.id}>
                    <th scope="row" className="px-3 py-2.5 text-start font-medium text-fg">
                      <span className="flex items-center gap-2">
                        {t.dyn(`permRegistry.modules.${m.id}`)}
                        {changed && !props.isAdmin && (
                          <span className="h-2 w-2 shrink-0 rounded-full bg-brand" title={t("access.changedHint")} aria-label={t("access.changed")} />
                        )}
                      </span>
                      {m.adminOnly && <span className="text-xs font-normal text-fg-subtle">{t("access.adminOnlyNote")}</span>}
                    </th>
                    <td className="px-3 py-2">
                      <Select
                        aria-label={`${t("access.level")}: ${t.dyn(`permRegistry.modules.${m.id}`)}`}
                        value={level}
                        disabled={rowLocked}
                        onChange={(e) => setLevel(m, e.target.value as Level)}
                        className="h-9 min-w-[10rem] text-xs"
                      >
                        {levelsOf(m).map((l) => (
                          <option key={l} value={l}>
                            {t.dyn(`permRegistry.levels.${l}`)}
                          </option>
                        ))}
                        {level === "custom" && <option value="custom">{t("permRegistry.levels.custom")}</option>}
                      </Select>
                    </td>
                    {COLUMNS.map((k) => (
                      <td key={k} className="px-2 py-2 text-center">
                        {byKind(k).length === 0 ? (
                          <span className="text-fg-subtle" aria-hidden>
                            {"—"}
                          </span>
                        ) : (
                          <div className="flex flex-col items-center gap-1">
                            {byKind(k).map((x) => (
                              <label key={x.permission} className="flex items-center gap-1 text-[11px] text-fg-muted" title={x.permission}>
                                <input
                                  type="checkbox"
                                  className="h-4 w-4 accent-[var(--brand-strong)]"
                                  checked={perms.has(x.permission)}
                                  disabled={rowLocked || !canToggle(x.permission)}
                                  onChange={(e) => toggle(x.permission, e.target.checked)}
                                  aria-label={`${t.dyn(`permRegistry.modules.${m.id}`)}: ${label(x)}`}
                                />
                                {x.label && <span className="max-w-[7rem] text-start leading-tight">{label(x)}</span>}
                              </label>
                            ))}
                          </div>
                        )}
                      </td>
                    ))}
                    <td className="px-3 py-2">
                      <div className="flex flex-col gap-1">
                        {byKind("special").map((x) => (
                          <label key={x.permission} className="flex items-center gap-1.5 text-xs text-fg-muted" title={x.permission}>
                            <input
                              type="checkbox"
                              className="h-4 w-4 accent-[var(--brand-strong)]"
                              checked={perms.has(x.permission)}
                              disabled={rowLocked || !canToggle(x.permission)}
                              onChange={(e) => toggle(x.permission, e.target.checked)}
                              aria-label={`${t.dyn(`permRegistry.modules.${m.id}`)}: ${label(x)}`}
                            />
                            {label(x)}
                          </label>
                        ))}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      {m.scopes?.length ? (
                        <Select
                          aria-label={`${t("access.scope")}: ${t.dyn(`permRegistry.modules.${m.id}`)}`}
                          value={scopes[m.id] ?? "ALL"}
                          disabled={locked}
                          onChange={(e) => setScopes((s) => ({ ...s, [m.id]: e.target.value }))}
                          className="h-9 min-w-[9rem] text-xs"
                        >
                          {m.scopes.map((sc) => (
                            <option key={sc} value={sc} title={t.dyn(`permRegistry.scopeHints.${sc}`)}>
                              {t.dyn(`permRegistry.scopes.${sc}`)}
                            </option>
                          ))}
                        </Select>
                      ) : (
                        <span className="text-fg-subtle" aria-hidden>
                          {"—"}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!locked && (
          <div className="flex flex-col gap-3 border-t border-line p-4 md:flex-row md:items-end">
            <Field label={t("access.reason")} className="min-w-0 flex-1">
              {(p) => <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} dir="auto" />}
            </Field>
            <div className="flex flex-wrap items-center gap-2">
              {changes > 0 && <Badge className="border-warning/40 bg-warning-soft text-fg">{t("access.unsaved", { count: changes })}</Badge>}
              <Button variant="ghost" loading={busy === "reset"} onClick={() => void send({ mode: "reset" }, "reset", t("access.resetConfirm"))}>
                <RotateCcw className="h-4 w-4" /> {t("access.reset")}
              </Button>
              <Button disabled={!changes} loading={busy === "set"} onClick={() => void send({ mode: "set", permissions: [...perms], scopes, teamId: teamId || null }, "set")}>
                <Save className="h-4 w-4" /> {t("access.save")}
              </Button>
            </div>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader title={t("access.effective")} description={`${t("access.effectiveText")} ${t("access.count", { count: props.effective.length })}`} />
        <div className="grid grid-cols-1 gap-4 p-5 md:grid-cols-2 xl:grid-cols-3">
          {MODULES.map((m) => {
            const held = m.actions.filter((x) => props.effective.includes(x.permission));
            const removed = m.actions.filter((x) => props.denies.includes(x.permission));
            if (!held.length && !removed.length) return null;
            return (
              <div key={m.id} className="text-sm" data-effective-module={m.id}>
                <p className="mb-1 font-medium text-fg">
                  {t.dyn(`permRegistry.modules.${m.id}`)}
                  {m.scopes?.length ? <span className="ms-2 text-xs font-normal text-fg-muted">· {t.dyn(`permRegistry.scopes.${props.scopes[m.id] ?? "ALL"}`)}</span> : null}
                </p>
                <ul className="flex flex-wrap gap-1">
                  {held.map((x) => (
                    <li key={x.permission}>
                      <Badge className={cn(props.grants.includes(x.permission) && "border-success/40 bg-success-soft text-fg")} title={x.permission}>
                        {label(x)} · {props.grants.includes(x.permission) ? t("access.sources.granted") : t("access.sources.role")}
                      </Badge>
                    </li>
                  ))}
                  {removed.map((x) => (
                    <li key={x.permission}>
                      <Badge className="border-danger/40 bg-danger-soft text-fg line-through" title={x.permission}>
                        {label(x)} · {t("access.sources.removed")}
                      </Badge>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}
