import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import type { Role } from "@prisma/client";
import { DEFAULT_LOCALE, LOCALE_COOKIE, isLocale, type Locale } from "@/i18n/config";
import { permissionsFor, type Permission } from "@/lib/permissions";
import type { SettingsValues } from "@/lib/validation";
import { prisma } from "../db";
import { parseSettings } from "../services/settings";
import { randomToken, sha256 } from "./crypto";

export const SESSION_COOKIE = "ims_session";

export type CurrentUser = {
  id: string;
  name: string;
  email: string;
  role: Role;
  color: string | null;
  isActive: boolean;
  viewerPermissions: string[];
  permissions: Permission[];
  settings: SettingsValues;
  sessionId: string;
  /** Interface language of this request: the language cookie, else the saved preference, else Arabic. */
  locale: Locale;
};

function sessionTtlMs(): number {
  const hours = Number(process.env.SESSION_TTL_HOURS ?? 12);
  return (Number.isFinite(hours) && hours > 0 ? hours : 12) * 60 * 60 * 1000;
}

export function secureCookies(): boolean {
  return process.env.NODE_ENV === "production" && !(process.env.APP_URL ?? "").startsWith("http://");
}

export async function createSession(userId: string, meta: { userAgent?: string | null; ipAddress?: string | null }) {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + sessionTtlMs());
  await prisma.session.create({
    data: {
      id: sha256(token),
      userId,
      expiresAt,
      userAgent: meta.userAgent?.slice(0, 300) ?? null,
      ipAddress: meta.ipAddress?.slice(0, 100) ?? null,
    },
  });
  return { token, expiresAt };
}

export function sessionCookie(token: string, expiresAt: Date) {
  return {
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: "lax" as const,
    secure: secureCookies(),
    path: "/",
    expires: expiresAt,
  };
}

export async function deleteSessionByToken(token: string | undefined | null) {
  if (!token) return;
  await prisma.session.deleteMany({ where: { id: sha256(token) } });
}

export async function deleteUserSessions(userId: string, exceptSessionId?: string) {
  await prisma.session.deleteMany({ where: { userId, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) } });
}

type SessionRow = {
  expiresAt: Date;
  lastSeenAt: Date;
  id: string;
  name: string;
  email: string;
  role: Role;
  color: string | null;
  isActive: boolean;
  viewerPermissions: string[];
  settings: unknown;
};

/** Validates a raw session token and loads the user with their effective permissions. */
export async function userFromToken(token: string | undefined | null, cookieLocale?: string | null): Promise<CurrentUser | null> {
  if (!token || token.length > 200) return null;
  const id = sha256(token);
  // Runs on every request, so session, user and settings come back in ONE round trip.
  const rows = await prisma.$queryRaw<SessionRow[]>`
    SELECT s."expiresAt", s."lastSeenAt", u.id, u.name, u.email, u.role, u.color, u."isActive", u."viewerPermissions",
           (SELECT value FROM settings WHERE key = 'general') AS settings
    FROM sessions s JOIN users u ON u.id = s."userId"
    WHERE s.id = ${id}`;
  const u = rows[0];
  if (!u) return null;
  if (u.expiresAt.getTime() <= Date.now() || !u.isActive) {
    await prisma.session.deleteMany({ where: { id } });
    return null;
  }
  // Touch at most every 5 minutes to avoid a write per request.
  if (Date.now() - u.lastSeenAt.getTime() > 5 * 60 * 1000) {
    await prisma.session.update({ where: { id }, data: { lastSeenAt: new Date() } }).catch(() => undefined);
  }
  const settings = parseSettings(u.settings);
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    color: u.color,
    isActive: u.isActive,
    viewerPermissions: u.viewerPermissions,
    permissions: [...permissionsFor(u, settings)],
    settings,
    sessionId: id,
    // The cookie decides (sign-in sets it from the saved preference), so pages and APIs agree.
    locale: isLocale(cookieLocale) ? cookieLocale : DEFAULT_LOCALE,
  };
}

export function cookieFromHeader(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

/** For API route handlers: reads the session and language cookies from the incoming request. */
export function getUserFromRequest(req: Request): Promise<CurrentUser | null> {
  const header = req.headers.get("cookie");
  return userFromToken(cookieFromHeader(header, SESSION_COOKIE), cookieFromHeader(header, LOCALE_COOKIE));
}

/** For server components and layouts (cached per request). */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const store = await cookies();
  return userFromToken(store.get(SESSION_COOKIE)?.value, store.get(LOCALE_COOKIE)?.value);
});

export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

/** For pages: renders the "access denied" page when the permission is missing. */
export async function requirePagePermission(permission: Permission): Promise<CurrentUser> {
  const user = await requireUser();
  if (!user.permissions.includes(permission)) redirect("/access-denied");
  return user;
}
