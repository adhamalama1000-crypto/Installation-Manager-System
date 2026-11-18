import "server-only";
import { Prisma, type Role } from "@prisma/client";
import { z } from "zod";
import { msg } from "@/i18n/translator";
import { ROLES } from "@/lib/constants";
import { MODULES, scopeOverrides, scopesFor, type DataScope } from "@/lib/permission-registry";
import { PERMISSIONS, permissionsFor, roleDefaults, type Permission } from "@/lib/permissions";
import { fieldErrorsFromZod } from "@/lib/validation";
import { prisma } from "../db";
import { assertCan } from "../access";
import type { CurrentUser } from "../auth/session";
import { ForbiddenError, NotFoundError, StaleRecordError, ValidationError } from "../errors";
import { recordAudit } from "./audit";
import { assignable } from "./access-control";

/**
 * Custom roles: named permission sets an Admin defines for people of one base role (for example an
 * "Installation supervisor" based on Sales, or a "Warehouse employee" based on Store keeper),
 * without code changes. Rules, enforced here:
 *   - only an active Admin manages roles;
 *   - a role never holds Admin-only permissions, and a Viewer-based role only view and export
 *     (the same limits as individual permissions);
 *   - the base role cannot change once the role exists (it decides record scoping);
 *   - roles are deactivated, never deleted, and only once nobody has them, so deactivating a role
 *     can never silently change anyone's access;
 *   - every change is audited with the permissions added and removed.
 * Editing a role changes the access of everyone who has it on their next request.
 */

export const BASE_ROLES = ROLES.filter((r) => r !== "ADMIN") as Exclude<Role, "ADMIN">[];

function assertAdmin(actor: CurrentUser) {
  assertCan(actor, "users.manage");
  if (actor.role !== "ADMIN") throw new ForbiddenError();
}

const text = (max: number) => z.preprocess((v) => (typeof v === "string" ? v.trim() || null : (v ?? null)), z.string().max(max).nullable());

const roleSchema = z.object({
  name: z.preprocess((v) => (typeof v === "string" ? v.trim() : v), z.string({ error: msg("accessRoles.errors.name") }).min(1, msg("accessRoles.errors.name")).max(80, msg("accessRoles.errors.name"))),
  nameAr: text(80).optional(),
  description: text(500).optional(),
  baseRole: z.enum(BASE_ROLES as [string, ...string[]], { error: msg("accessRoles.errors.baseRole") }).optional(),
  permissions: z.array(z.string().max(60)).max(200).optional(),
  scopes: z.record(z.string().max(40), z.enum(["OWN", "ASSIGNED", "TEAM", "ALL"])).optional(),
  isActive: z.boolean().optional(),
  version: z.number().int().positive().optional(),
  reason: text(500).optional(),
});

export type AccessRoleDTO = Awaited<ReturnType<typeof listAccessRoles>>["custom"][number];

/** The built-in roles (with their default permissions) and every custom role. */
export async function listAccessRoles(actor: CurrentUser) {
  assertAdmin(actor);
  const [roles, counts] = await Promise.all([
    prisma.accessRole.findMany({ orderBy: [{ isActive: "desc" }, { name: "asc" }], include: { _count: { select: { members: true } } } }),
    prisma.user.groupBy({ by: ["role"], where: { accessRoleId: null }, _count: { _all: true } }),
  ]);
  const settings = actor.settings;
  return {
    builtIn: ROLES.map((role) => ({
      role,
      permissions: role === "ADMIN" ? [...PERMISSIONS] : PERMISSIONS.filter((p) => roleDefaults({ role }, settings).has(p)),
      people: counts.find((c) => c.role === role)?._count._all ?? 0,
    })),
    custom: roles.map((r) => ({
      id: r.id,
      name: r.name,
      nameAr: r.nameAr,
      description: r.description,
      baseRole: r.baseRole,
      permissions: PERMISSIONS.filter((p) => r.permissions.includes(p)),
      scopes: scopesFor({ role: r.baseRole, permissions: new Set(r.permissions) }, r.dataScopes),
      isActive: r.isActive,
      version: r.version,
      people: r._count.members,
      updatedAt: r.updatedAt.toISOString(),
    })),
  };
}

/** One custom role with what the editor needs (assignable permissions, defaults of the base role). */
export async function getAccessRole(actor: CurrentUser, id: string) {
  assertAdmin(actor);
  if (typeof id !== "string" || id.length > 64) throw new NotFoundError();
  const r = await prisma.accessRole.findUnique({ where: { id }, include: { members: { select: { id: true, name: true, isActive: true }, orderBy: { name: "asc" } } } });
  if (!r) throw new NotFoundError();
  const settings = actor.settings;
  const held = new Set(r.permissions);
  return {
    id: r.id,
    name: r.name,
    nameAr: r.nameAr,
    description: r.description,
    baseRole: r.baseRole,
    isActive: r.isActive,
    version: r.version,
    permissions: PERMISSIONS.filter((p) => held.has(p)),
    scopes: scopesFor({ role: r.baseRole, permissions: held }, r.dataScopes),
    baseDefaults: PERMISSIONS.filter((p) => roleDefaults({ role: r.baseRole }, settings).has(p)),
    baseScopes: scopesFor({ role: r.baseRole, permissions: held }, null),
    assignable: PERMISSIONS.filter((p) => assignable(r.baseRole, p)),
    members: r.members,
  };
}

/** What the role will actually give (never more than the base role may hold). */
function cleanPermissions(baseRole: Role, wanted: string[]): Permission[] {
  const want = new Set(wanted);
  return PERMISSIONS.filter((p) => want.has(p) && assignable(baseRole, p));
}

function cleanScopes(baseRole: Role, permissions: Permission[], wanted: Record<string, string> | undefined): Record<string, DataScope> {
  return scopeOverrides({ role: baseRole, permissions: new Set(permissions) }, wanted ?? {});
}

/** Creates a custom role; without permissions it starts from the base role's defaults. */
export async function createAccessRole(actor: CurrentUser, raw: unknown) {
  assertAdmin(actor);
  const parsed = roleSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(fieldErrorsFromZod(parsed.error));
  const v = parsed.data;
  if (!v.baseRole) throw new ValidationError({ baseRole: msg("accessRoles.errors.baseRole") });
  const baseRole = v.baseRole as Role;
  const settings = actor.settings;
  const refused = (v.permissions ?? []).filter((p) => !assignable(baseRole, p));
  if (refused.length) throw new ValidationError({ permissions: msg("access.errors.notAssignable", { permissions: refused.join(", ") }) });
  const permissions = cleanPermissions(baseRole, v.permissions ?? [...roleDefaults({ role: baseRole }, settings)]);
  const scopes = cleanScopes(baseRole, permissions, v.scopes);
  return prisma.$transaction(async (tx) => {
    const r = await tx.accessRole.create({
      data: {
        name: v.name,
        nameAr: v.nameAr ?? null,
        description: v.description ?? null,
        baseRole,
        permissions,
        dataScopes: Object.keys(scopes).length ? (scopes as Prisma.InputJsonValue) : Prisma.DbNull,
        createdById: actor.id,
      },
    });
    await recordAudit(tx, {
      entityType: "USER",
      entityId: r.id,
      module: "users",
      action: "ACCESS_ROLE_CREATED",
      summary: msg("accessRoles.audit.created", { name: actor.name, role: r.name }),
      reason: v.reason ?? null,
      changes: { name: r.name, baseRole, permissions, scopes },
      actorId: actor.id,
    });
    return { id: r.id };
  });
}

/** Changes a custom role (name, description, permissions, scopes, active), with optimistic locking. */
export async function updateAccessRole(actor: CurrentUser, id: string, raw: unknown) {
  assertAdmin(actor);
  const parsed = roleSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(fieldErrorsFromZod(parsed.error));
  const v = parsed.data;
  if (typeof id !== "string" || id.length > 64) throw new NotFoundError();
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM access_roles WHERE id = ${id} FOR UPDATE`;
    if (!rows.length) throw new NotFoundError();
    const before = await tx.accessRole.findUniqueOrThrow({ where: { id }, include: { _count: { select: { members: true } } } });
    if (v.version !== undefined && v.version !== before.version) throw new StaleRecordError();
    if (v.baseRole && v.baseRole !== before.baseRole) throw new ValidationError({ baseRole: msg("accessRoles.errors.baseRoleFixed") });
    const refused = (v.permissions ?? []).filter((p) => !assignable(before.baseRole, p));
    if (refused.length) throw new ValidationError({ permissions: msg("access.errors.notAssignable", { permissions: refused.join(", ") }) });
    if (v.isActive === false && before.isActive && before._count.members > 0) {
      throw new ValidationError({ isActive: msg("accessRoles.errors.inUse", { count: before._count.members }) });
    }
    const permissions = v.permissions ? cleanPermissions(before.baseRole, v.permissions) : (before.permissions as Permission[]);
    const scopes = v.scopes ? cleanScopes(before.baseRole, permissions, v.scopes) : (before.dataScopes as Record<string, DataScope> | null) ?? {};
    const added = permissions.filter((p) => !before.permissions.includes(p));
    const removed = before.permissions.filter((p) => !permissions.includes(p as Permission));
    const beforeScopes = scopesFor({ role: before.baseRole, permissions: new Set(before.permissions) }, before.dataScopes);
    const afterScopes = scopesFor({ role: before.baseRole, permissions: new Set(permissions) }, scopes);
    const scopeChanges = Object.fromEntries(MODULES.filter((m) => afterScopes[m.id] !== beforeScopes[m.id]).map((m) => [m.id, { from: beforeScopes[m.id], to: afterScopes[m.id] }]));
    const fields = {
      name: v.name,
      nameAr: v.nameAr === undefined ? before.nameAr : v.nameAr,
      description: v.description === undefined ? before.description : v.description,
      isActive: v.isActive ?? before.isActive,
    };
    const fieldChanges = Object.fromEntries(
      (Object.keys(fields) as (keyof typeof fields)[]).filter((k) => fields[k] !== before[k]).map((k) => [k, { from: before[k], to: fields[k] }]),
    );
    if (!added.length && !removed.length && !Object.keys(scopeChanges).length && !Object.keys(fieldChanges).length) return { changed: false, version: before.version };
    const r = await tx.accessRole.update({
      where: { id },
      data: {
        ...fields,
        permissions,
        dataScopes: Object.keys(scopes).length ? (scopes as Prisma.InputJsonValue) : Prisma.DbNull,
        updatedById: actor.id,
        version: { increment: 1 },
      },
    });
    await recordAudit(tx, {
      entityType: "USER",
      entityId: id,
      module: "users",
      action: "ACCESS_ROLE_UPDATED",
      summary: msg("accessRoles.audit.updated", { name: actor.name, role: r.name, count: before._count.members }),
      reason: v.reason ?? null,
      changes: { ...fieldChanges, permissionsAdded: added, permissionsRemoved: removed, scopes: scopeChanges, people: before._count.members },
      actorId: actor.id,
    });
    return { changed: true, version: r.version };
  });
}

/** Effective permissions someone with this role and no individual changes would have (for previews). */
export function roleEffective(baseRole: Role, permissions: string[], settings: CurrentUser["settings"]) {
  return permissionsFor({ role: baseRole, isActive: true, rolePermissions: permissions }, settings);
}
