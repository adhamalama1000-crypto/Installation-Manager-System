"use client";

import type { Dispatch, SetStateAction } from "react";
import { Select } from "@/components/ui/field";
import { useT } from "@/i18n/client";
import { ACTION_KINDS, MODULES, levelOf, levelsOf, permissionsForLevel, type ActionKind, type DataScope, type Level, type ModuleAction, type ModuleDef } from "@/lib/permission-registry";

/** The matrix columns: the standard actions; named special actions go to "Other". */
const COLUMNS = ACTION_KINDS.filter((k) => k !== "special");

export type PermissionMatrixProps = {
  ariaLabel: string;
  perms: Set<string>;
  setPerms: Dispatch<SetStateAction<Set<string>>>;
  scopes: Record<string, string>;
  setScopes: Dispatch<SetStateAction<Record<string, string>>>;
  /** Permissions that may be ticked at all (the server re-checks). */
  assignable: Set<string>;
  /** What the starting template gives (a dot marks rows that differ). */
  defaults: Set<string>;
  defaultScopes: Record<string, DataScope>;
  locked: boolean;
  showChanged: boolean;
};

/**
 * One row per module: a level (no access … full access, or custom), a checkbox per action, the
 * module's special actions and which records (own / assigned / team / all). Used for one person's
 * permissions and for a custom role. Only builds the request: the server decides.
 */
export function PermissionMatrix({ ariaLabel, perms, setPerms, scopes, setScopes, assignable, defaults, defaultScopes, locked, showChanged }: PermissionMatrixProps) {
  const t = useT();
  const label = (x: ModuleAction) => (x.label ? t.dyn(`permRegistry.special.${x.label}`) : t.dyn(`permRegistry.actions.${x.kind}`));
  const canToggle = (p: string) => !locked && (assignable.has(p) || perms.has(p));

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

  const box = (m: ModuleDef, x: ModuleAction, rowLocked: boolean, withLabel: boolean) => (
    <label key={x.permission} className={withLabel ? "flex items-center gap-1.5 text-xs text-fg-muted" : "flex items-center gap-1 text-[11px] text-fg-muted"} title={x.permission}>
      <input
        type="checkbox"
        className="h-4 w-4 accent-[var(--brand-strong)]"
        checked={perms.has(x.permission)}
        disabled={rowLocked || !canToggle(x.permission)}
        onChange={(e) => toggle(x.permission, e.target.checked)}
        aria-label={`${t.dyn(`permRegistry.modules.${m.id}`)}: ${label(x)}`}
      />
      {(withLabel || x.label) && <span className="max-w-[7rem] text-start leading-tight">{label(x)}</span>}
    </label>
  );

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[980px] text-sm" aria-label={ariaLabel}>
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
            const changed = m.actions.some((x) => perms.has(x.permission) !== defaults.has(x.permission)) || (m.scopes?.length ? scopes[m.id] !== defaultScopes[m.id] : false);
            const rowLocked = locked || !!m.adminOnly;
            const byKind = (k: ActionKind) => m.actions.filter((x) => x.kind === k);
            return (
              <tr key={m.id} className="align-top" data-module={m.id}>
                <th scope="row" className="px-3 py-2.5 text-start font-medium text-fg">
                  <span className="flex items-center gap-2">
                    {t.dyn(`permRegistry.modules.${m.id}`)}
                    {changed && showChanged && <span className="h-2 w-2 shrink-0 rounded-full bg-brand" title={t("access.changedHint")} aria-label={t("access.changed")} />}
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
                      <div className="flex flex-col items-center gap-1">{byKind(k).map((x) => box(m, x, rowLocked, false))}</div>
                    )}
                  </td>
                ))}
                <td className="px-3 py-2">
                  <div className="flex flex-col gap-1">{byKind("special").map((x) => box(m, x, rowLocked, true))}</div>
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
  );
}
