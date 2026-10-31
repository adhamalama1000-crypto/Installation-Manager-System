import "server-only";
import { Prisma, type Role, type User } from "@prisma/client";
import { msg } from "@/i18n/translator";
import { SALES_COLOR_SUGGESTIONS } from "@/lib/constants";
import { DEFAULT_VIEWER_PERMISSIONS } from "@/lib/permissions";
import type { UserDTO } from "@/lib/types";
import { fieldErrorsFromZod, userCreateSchema, userUpdateSchema } from "@/lib/validation";
import { prisma, type Tx } from "../db";
import { assertCan } from "../access";
import { randomToken, sha256 } from "../auth/crypto";
import { hashPassword } from "../auth/password";
import type { CurrentUser } from "../auth/session";
import { deleteUserSessions } from "../auth/session";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { diffValues, recordAudit } from "./audit";
import { isUniqueViolation } from "./scheduling";

const INVITE_TTL_HOURS = 72;
const RESET_TTL_HOURS = 24;

export function toUserDTO(u: User): UserDTO {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    phone: u.phone,
    role: u.role,
    isActive: u.isActive,
    color: u.color,
    viewerPermissions: u.viewerPermissions,
    hasPassword: Boolean(u.passwordHash),
    createdAt: u.createdAt.toISOString(),
    updatedAt: u.updatedAt.toISOString(),
  };
}

export async function listUsers(actor: CurrentUser) {
  assertCan(actor, "users.manage");
  const users = await prisma.user.findMany({ orderBy: [{ isActive: "desc" }, { role: "asc" }, { name: "asc" }] });
  return users.map(toUserDTO);
}

export async function getUser(actor: CurrentUser, id: string) {
  assertCan(actor, "users.manage");
  const u = await prisma.user.findUnique({ where: { id } });
  if (!u) throw new NotFoundError("userErrors.notFound");
  return toUserDTO(u);
}

/** Active technicians available for new assignments (no hard-coded names anywhere). */
export async function activeTechnicians() {
  return prisma.user.findMany({
    where: { role: "TECHNICIAN", isActive: true },
    select: { id: true, name: true, color: true, isActive: true },
    orderBy: { name: "asc" },
  });
}

/** Users that can appear as the Sales creator / colour legend (Sales, plus Admins with bookings). */
export async function salesPeople(options: { includeInactive?: boolean } = {}) {
  // "Has this user created an appointment?" as EXISTS per user let the planner pick a sequential
  // scan of all appointments for every user who never created one (190 ms with 33k appointments).
  // Instead the distinct creators are walked through the (createdById, startsAt) index, one probe
  // per creator (a "loose index scan").
  return prisma.$queryRaw<{ id: string; name: string; color: string | null; isActive: boolean; role: Role }[]>`
    WITH RECURSIVE creators AS (
      (SELECT "createdById" AS id FROM appointments ORDER BY "createdById" LIMIT 1)
      UNION ALL
      SELECT (SELECT a."createdById" FROM appointments a WHERE a."createdById" > c.id ORDER BY a."createdById" LIMIT 1)
      FROM creators c WHERE c.id IS NOT NULL
    )
    SELECT u.id, u.name, u.color, u."isActive", u.role::text AS role
    FROM users u
    WHERE (u.role IN ('SALES', 'ADMIN') OR u.id IN (SELECT id FROM creators WHERE id IS NOT NULL))
      ${options.includeInactive ? Prisma.empty : Prisma.sql`AND u."isActive"`}
    ORDER BY u.name ASC`;
}

async function nextSuggestedColor(tx: Tx): Promise<string> {
  const used = new Set(
    (await tx.user.findMany({ where: { color: { not: null } }, select: { color: true } })).map((u) => u.color!.toUpperCase()),
  );
  return SALES_COLOR_SUGGESTIONS.find((c) => !used.has(c.toUpperCase())) ?? SALES_COLOR_SUGGESTIONS[used.size % SALES_COLOR_SUGGESTIONS.length]!;
}

async function issuePasswordToken(tx: Tx, userId: string, purpose: "INVITE" | "RESET", createdById: string) {
  // Only one valid link at a time.
  await tx.passwordToken.updateMany({ where: { userId, usedAt: null }, data: { usedAt: new Date() } });
  const token = randomToken();
  const hours = purpose === "INVITE" ? INVITE_TTL_HOURS : RESET_TTL_HOURS;
  const expiresAt = new Date(Date.now() + hours * 3600 * 1000);
  await tx.passwordToken.create({ data: { tokenHash: sha256(token), userId, purpose, expiresAt, createdById } });
  const base = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  return { url: `${base}/set-password?token=${encodeURIComponent(token)}`, expiresAt: expiresAt.toISOString() };
}

export async function createUser(actor: CurrentUser, raw: unknown) {
  assertCan(actor, "users.manage");
  const parsed = userCreateSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(fieldErrorsFromZod(parsed.error));
  const input = parsed.data;
  const role = input.role as Role;
  const passwordHash = input.password ? await hashPassword(input.password) : null;
  try {
    return await prisma.$transaction(async (tx) => {
      // Sales and Admins can book appointments, so they always get a distinct calendar colour.
      const color = input.color ?? (role === "SALES" || role === "ADMIN" ? await nextSuggestedColor(tx) : null);
      const user = await tx.user.create({
        data: {
          name: input.name,
          email: input.email,
          phone: input.phone ?? null,
          role,
          color,
          viewerPermissions: role === "VIEWER" ? (input.viewerPermissions ?? DEFAULT_VIEWER_PERMISSIONS) : [],
          passwordHash,
          passwordChangedAt: passwordHash ? new Date() : null,
        },
      });
      await recordAudit(tx, {
        entityType: "USER",
        entityId: user.id,
        action: "USER_CREATED",
        summary: msg("audit.userCreated", { role: `@enums.role.${role}`, name: user.name, email: user.email }),
        changes: { name: user.name, email: user.email, role, color, viewerPermissions: user.viewerPermissions },
        actorId: actor.id,
      });
      const invite = passwordHash ? null : await issuePasswordToken(tx, user.id, "INVITE", actor.id);
      return { user: toUserDTO(user), invite };
    });
  } catch (e) {
    if (isUniqueViolation(e, "email")) throw new ValidationError({ email: msg("userErrors.emailExists") });
    throw e;
  }
}

export async function updateUser(actor: CurrentUser, id: string, raw: unknown) {
  assertCan(actor, "users.manage");
  const parsed = userUpdateSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(fieldErrorsFromZod(parsed.error));
  const input = parsed.data;
  try {
    return await prisma.$transaction(async (tx) => {
      const before = await tx.user.findUnique({ where: { id } });
      if (!before) throw new NotFoundError("userErrors.notFound");
      const role = (input.role as Role | undefined) ?? before.role;

      if (id === actor.id && (input.isActive === false || (input.role && input.role !== "ADMIN"))) {
        throw new ForbiddenError("userErrors.ownAccount");
      }
      if (before.role === "ADMIN" && before.isActive && (role !== "ADMIN" || input.isActive === false)) {
        const otherAdmins = await tx.user.count({ where: { role: "ADMIN", isActive: true, id: { not: id } } });
        if (otherAdmins === 0) throw new ValidationError({ role: msg("userErrors.lastAdmin") });
      }

      let color = input.color === undefined ? before.color : input.color;
      if ((role === "SALES" || role === "ADMIN") && !color) color = await nextSuggestedColor(tx);

      const after = await tx.user.update({
        where: { id },
        data: {
          name: input.name,
          email: input.email,
          phone: input.phone === undefined ? undefined : input.phone,
          role,
          isActive: input.isActive,
          color,
          viewerPermissions: role === "VIEWER" ? (input.viewerPermissions ?? before.viewerPermissions) : [],
        },
      });

      const changes = diffValues(
        before as unknown as Record<string, unknown>,
        after as unknown as Record<string, unknown>,
        ["name", "email", "phone", "role", "isActive", "color", "viewerPermissions"],
      );
      if (Object.keys(changes).length) {
        const action = changes.isActive
          ? after.isActive
            ? "USER_ACTIVATED"
            : "USER_DEACTIVATED"
          : changes.role
            ? "USER_ROLE_CHANGED"
            : changes.viewerPermissions
              ? "USER_PERMISSIONS_CHANGED"
              : "USER_UPDATED";
        await recordAudit(tx, {
          entityType: "USER",
          entityId: id,
          action,
          summary: msg("audit.userUpdated", { name: after.name, fields: Object.keys(changes).join(", ") }),
          changes,
          actorId: actor.id,
        });
      }
      // Changing someone's access invalidates their existing sessions immediately.
      if (changes.isActive || changes.role || changes.viewerPermissions || changes.email) {
        await tx.session.deleteMany({ where: { userId: id } });
      }
      return toUserDTO(after);
    });
  } catch (e) {
    if (isUniqueViolation(e, "email")) throw new ValidationError({ email: msg("userErrors.emailExists") });
    throw e;
  }
}

/** Admin-initiated password reset: returns a one-time link to hand to the user. */
export async function createPasswordLink(actor: CurrentUser, id: string) {
  assertCan(actor, "users.manage");
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundError("userErrors.notFound");
    if (!user.isActive) throw new ValidationError({ _form: msg("userErrors.inactiveReset") });
    const purpose = user.passwordHash ? "RESET" : "INVITE";
    const link = await issuePasswordToken(tx, id, purpose, actor.id);
    await recordAudit(tx, {
      entityType: "USER",
      entityId: id,
      action: purpose === "RESET" ? "USER_PASSWORD_RESET_ISSUED" : "USER_INVITE_ISSUED",
      summary: msg(purpose === "RESET" ? "audit.resetLink" : "audit.inviteLink", { name: user.name }),
      actorId: actor.id,
    });
    return link;
  });
}

/** Consumes a one-time link and sets the password. */
export async function setPasswordWithToken(token: string, password: string) {
  const tokenHash = sha256(token);
  const userId = await prisma.$transaction(async (tx) => {
    const row = await tx.passwordToken.findUnique({ where: { tokenHash }, include: { user: true } });
    if (!row || row.usedAt || row.expiresAt.getTime() < Date.now() || !row.user.isActive) {
      throw new ValidationError({ token: msg("auth.linkInvalid") });
    }
    // Mark used atomically so the same link cannot be used twice.
    const used = await tx.passwordToken.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
    if (used.count !== 1) throw new ValidationError({ token: msg("userErrors.linkUsed") });
    await tx.user.update({
      where: { id: row.userId },
      data: { passwordHash: await hashPassword(password), passwordChangedAt: new Date() },
    });
    await recordAudit(tx, {
      entityType: "USER",
      entityId: row.userId,
      action: "USER_PASSWORD_SET",
      summary: msg("audit.passwordSet", { name: row.user.name }),
      actorId: row.userId,
    });
    return row.userId;
  });
  await deleteUserSessions(userId);
  return userId;
}
