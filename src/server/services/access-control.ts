import "server-only";
import { Prisma, type Role, type User } from "@prisma/client";
import { z } from "zod";
import { msg } from "@/i18n/translator";
import { ADMIN_ONLY_PERMISSIONS, MODULES, scopeOverrides, scopesFor, viewerMayHold, type DataScope } from "@/lib/permission-registry";
import { TEMPLATE_IDS, templateFor, type TemplateId } from "@/lib/permission-templates";
import { PERMISSIONS, overridesFor, permissionsFor, roleDefaults, type Permission } from "@/lib/permissions";
import { prisma, type Tx } from "../db";
import { assertCan } from "../access";
import type { CurrentUser } from "../auth/session";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { recordAudit } from "./audit";

/**
 * Individual permissions, data scopes and teams (the permission screen in Users). Escalation rules,
 * all enforced here on the server:
 *   - only an active Admin (role ADMIN with users.manage) manages anyone's access;
 *   - nobody changes their own permissions, scopes or team (an Admin cannot either: another Admin
 *     does it), so no one can raise their own privileges;
 *   - Admins always have every permission (nothing to configure); Admin-only permissions (users,
 *     settings, audit log) are never stored for anyone else;
 *   - a Viewer stays read-only: only view and export permissions can be given;
 *   - every change is audited with the old and new values and the reason.
 */

const ALL = new Set<string>(PERMISSIONS);

function assertAdmin(actor: CurrentUser) {
  assertCan(actor, "users.manage");
  if (actor.role !== "ADMIN") throw new ForbiddenError();
}

function subjectOf(u: Pick<User, "role" | "viewerPermissions" | "isActive" | "permissionGrants" | "permissionDenies">) {
  return { role: u.role, viewerPermissions: u.viewerPermissions, isActive: true, permissionGrants: u.permissionGrants, permissionDenies: u.permissionDenies };
}

/** What a role may be given at all (everything but Admin-only; Viewers: view and export only). */
export function assignable(role: Role, permission: string): boolean {
  if (!ALL.has(permission) || (ADMIN_ONLY_PERMISSIONS as string[]).includes(permission)) return false;
  return role !== "VIEWER" || viewerMayHold(permission);
}

export type UserAccessDTO = Awaited<ReturnType<typeof getUserAccess>>;

/** Everything the permission screen shows for one person. */
export async function getUserAccess(actor: CurrentUser, userId: string) {
  assertAdmin(actor);
  if (typeof userId !== "string" || userId.length > 64) throw new NotFoundError("userErrors.notFound");
  const [u, people, teams] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId } }),
    prisma.user.findMany({ where: { id: { not: userId } }, select: { id: true, name: true, role: true, isActive: true }, orderBy: [{ isActive: "desc" }, { name: "asc" }] }),
    prisma.team.findMany({ orderBy: [{ isActive: "desc" }, { name: "asc" }] }),
  ]);
  if (!u) throw new NotFoundError("userErrors.notFound");
  const settings = actor.settings;
  const defaults = roleDefaults(u, settings);
  const effective = permissionsFor(subjectOf(u), settings);
  return {
    user: { id: u.id, name: u.name, email: u.email, role: u.role, isActive: u.isActive, teamId: u.teamId },
    isSelf: u.id === actor.id,
    isAdmin: u.role === "ADMIN",
    roleDefaults: PERMISSIONS.filter((p) => defaults.has(p)),
    grants: (u.permissionGrants ?? []).filter((p) => ALL.has(p)),
    denies: (u.permissionDenies ?? []).filter((p) => ALL.has(p)),
    effective: PERMISSIONS.filter((p) => effective.has(p)),
    assignable: PERMISSIONS.filter((p) => assignable(u.role, p)),
    scopes: scopesFor({ role: u.role, permissions: effective }, u.dataScopes),
    defaultScopes: scopesFor({ role: u.role, permissions: effective }, null),
    templates: TEMPLATE_IDS.map((id) => {
      const tpl = templateFor(id, settings);
      return { id, permissions: tpl.permissions.filter((p) => assignable(u.role, p)), scopes: tpl.scopes };
    }),
    people,
    teams: teams.map((t) => ({ id: t.id, name: t.name, nameAr: t.nameAr, isActive: t.isActive })),
  };
}

const scopesSchema = z.record(z.string().max(40), z.enum(["OWN", "ASSIGNED", "TEAM", "ALL"])).optional();
const accessSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("set"),
    permissions: z.array(z.string().max(60)).max(200),
    scopes: scopesSchema,
    teamId: z.string().max(64).nullable().optional(),
    reason: z.preprocess((v) => (typeof v === "string" ? v.trim() || null : (v ?? null)), z.string().max(500).nullable()),
  }),
  z.object({ mode: z.literal("reset"), reason: z.preprocess((v) => (typeof v === "string" ? v.trim() || null : (v ?? null)), z.string().max(500).nullable()) }),
  z.object({ mode: z.literal("copy"), fromUserId: z.string().min(1).max(64), reason: z.preprocess((v) => (typeof v === "string" ? v.trim() || null : (v ?? null)), z.string().max(500).nullable()) }),
  z.object({ mode: z.literal("template"), template: z.enum(TEMPLATE_IDS), reason: z.preprocess((v) => (typeof v === "string" ? v.trim() || null : (v ?? null)), z.string().max(500).nullable()) }),
]);

async function lockUser(tx: Tx, id: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM users WHERE id = ${id} FOR UPDATE`;
  if (!rows.length) throw new NotFoundError("userErrors.notFound");
  return tx.user.findUniqueOrThrow({ where: { id } });
}

/**
 * Sets a person's individual permissions (the wanted effective set), data scopes and team; resets
 * them to the role's defaults; copies another person's; or applies a template.
 */
export async function setUserAccess(actor: CurrentUser, userId: string, raw: unknown) {
  assertAdmin(actor);
  const parsed = accessSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError({ _form: msg("access.errors.invalid") }, msg("access.errors.invalid"));
  const input = parsed.data;
  if (typeof userId !== "string" || userId.length > 64) throw new NotFoundError("userErrors.notFound");
  if (userId === actor.id) throw new ForbiddenError("access.errors.own");
  const settings = actor.settings;

  return prisma.$transaction(async (tx) => {
    const before = await lockUser(tx, userId);
    if (before.role === "ADMIN") throw new ValidationError({ _form: msg("access.errors.admin") }, msg("access.errors.admin"));

    let wanted: string[];
    let wantedScopes: Record<string, string>;
    let teamId = before.teamId;
    if (input.mode === "reset") {
      wanted = [...roleDefaults(before, settings)];
      wantedScopes = {};
    } else if (input.mode === "template") {
      const tpl = templateFor(input.template as TemplateId, settings);
      wanted = tpl.permissions;
      wantedScopes = tpl.scopes;
    } else if (input.mode === "copy") {
      if (input.fromUserId === userId) throw new ValidationError({ fromUserId: msg("access.errors.copySelf") }, msg("access.errors.copySelf"));
      const src = await tx.user.findUnique({ where: { id: input.fromUserId } });
      if (!src) throw new NotFoundError("userErrors.notFound");
      const srcPerms = permissionsFor({ ...subjectOf(src), isActive: true }, settings);
      wanted = [...srcPerms];
      wantedScopes = scopesFor({ role: src.role, permissions: srcPerms }, src.dataScopes);
    } else {
      wanted = input.permissions;
      wantedScopes = input.scopes ?? {};
      if (input.teamId !== undefined) {
        if (input.teamId) {
          const team = await tx.team.findUnique({ where: { id: input.teamId } });
          if (!team || !team.isActive) throw new ValidationError({ teamId: msg("access.errors.team") }, msg("access.errors.team"));
        }
        teamId = input.teamId;
      }
    }
    // Never more than the role may hold, whatever was sent.
    const refused = wanted.filter((p) => !assignable(before.role, p) && ALL.has(p) && !roleDefaults(before, settings).has(p as Permission));
    if (input.mode === "set" && refused.length) {
      throw new ValidationError({ _form: msg("access.errors.notAssignable", { permissions: refused.join(", ") }) }, msg("access.errors.notAssignable", { permissions: refused.join(", ") }));
    }
    const allowed = wanted.filter((p) => assignable(before.role, p));
    const { grants, denies } = overridesFor(before, settings, allowed);
    const after = permissionsFor({ role: before.role, viewerPermissions: before.viewerPermissions, permissionGrants: grants, permissionDenies: denies }, settings);
    const scopes = scopeOverrides({ role: before.role, permissions: after }, wantedScopes);

    const beforeEffective = permissionsFor(subjectOf(before), settings);
    const beforeScopes = scopesFor({ role: before.role, permissions: beforeEffective }, before.dataScopes);
    const afterScopes = scopesFor({ role: before.role, permissions: after }, scopes);
    const added = PERMISSIONS.filter((p) => after.has(p) && !beforeEffective.has(p));
    const removed = PERMISSIONS.filter((p) => !after.has(p) && beforeEffective.has(p));
    const scopeChanges = Object.fromEntries(Object.keys(afterScopes).filter((m) => afterScopes[m] !== beforeScopes[m]).map((m) => [m, { from: beforeScopes[m], to: afterScopes[m] }]));
    const teamChanged = teamId !== before.teamId;
    if (!added.length && !removed.length && !Object.keys(scopeChanges).length && !teamChanged && input.mode === "set") return { changed: false };

    await tx.user.update({
      where: { id: userId },
      data: { permissionGrants: grants, permissionDenies: denies, dataScopes: Object.keys(scopes).length ? (scopes as Prisma.InputJsonValue) : Prisma.DbNull, teamId },
    });
    await recordAudit(tx, {
      entityType: "USER",
      entityId: userId,
      module: "users",
      action: "USER_ACCESS_CHANGED",
      summary: msg("access.audit.changed", { name: actor.name, person: before.name, mode: `@access.audit.modes.${input.mode}` }),
      reason: input.reason ?? null,
      changes: {
        mode: input.mode,
        ...(input.mode === "template" ? { template: input.template } : {}),
        ...(input.mode === "copy" ? { copiedFrom: input.fromUserId } : {}),
        permissionsAdded: added,
        permissionsRemoved: removed,
        grants: { from: before.permissionGrants ?? [], to: grants },
        denies: { from: before.permissionDenies ?? [], to: denies },
        scopes: scopeChanges,
        ...(teamChanged ? { teamId: { from: before.teamId, to: teamId } } : {}),
      },
      actorId: actor.id,
    });
    return { changed: true, added, removed };
  });
}

/** The effective scope of every scoped module for a stored user (for lists and checks). */
export function effectiveScopes(u: Pick<User, "role" | "viewerPermissions" | "permissionGrants" | "permissionDenies" | "dataScopes">, settings: CurrentUser["settings"]): Record<string, DataScope> {
  const perms = permissionsFor({ ...u, isActive: true }, settings);
  return scopesFor({ role: u.role, permissions: perms }, u.dataScopes);
}

// ---------------------------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------------------------

const teamSchema = z.object({
  name: z.preprocess((v) => (typeof v === "string" ? v.trim() : v), z.string({ error: msg("teams.errors.name") }).min(1, msg("teams.errors.name")).max(80)),
  // Left out of a change, the Arabic name stays as it is.
  nameAr: z.preprocess((v) => (v === undefined ? undefined : typeof v === "string" ? v.trim() || null : v), z.string().max(80).nullable().optional()),
  isActive: z.boolean().optional(),
});

export async function listTeams(actor: CurrentUser) {
  assertAdmin(actor);
  const rows = await prisma.team.findMany({ orderBy: [{ isActive: "desc" }, { name: "asc" }], include: { _count: { select: { members: true } } } });
  return rows.map((t) => ({ id: t.id, name: t.name, nameAr: t.nameAr, isActive: t.isActive, members: t._count.members }));
}

/** Creates (id null) or changes a team. Teams are deactivated, never deleted. */
export async function saveTeam(actor: CurrentUser, id: string | null, raw: unknown) {
  assertAdmin(actor);
  const parsed = teamSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError({ name: msg("teams.errors.name") });
  const v = parsed.data;
  return prisma.$transaction(async (tx) => {
    const before = id ? await tx.team.findUnique({ where: { id } }) : null;
    if (id && !before) throw new NotFoundError();
    const t = before ? await tx.team.update({ where: { id: before.id }, data: v }) : await tx.team.create({ data: v });
    await recordAudit(tx, {
      entityType: "USER",
      entityId: t.id,
      module: "users",
      action: before ? "TEAM_UPDATED" : "TEAM_CREATED",
      summary: msg(before ? "teams.audit.updated" : "teams.audit.created", { name: actor.name, team: t.name }),
      changes: before ? { name: { from: before.name, to: t.name }, nameAr: { from: before.nameAr, to: t.nameAr }, isActive: { from: before.isActive, to: t.isActive } } : { name: t.name, nameAr: t.nameAr },
      actorId: actor.id,
    });
    return { id: t.id };
  });
}

/** Module ids, for validation of stored scopes elsewhere. */
export const SCOPED = MODULES.filter((m) => m.scopes?.length).map((m) => m.id);
