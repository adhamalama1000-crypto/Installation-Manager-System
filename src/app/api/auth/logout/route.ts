import { NextResponse } from "next/server";
import { msg } from "@/i18n/translator";
import { prisma } from "@/server/db";
import { recordAudit } from "@/server/services/audit";
import { publicRoute } from "@/server/http";
import { SESSION_COOKIE, cookieFromHeader, deleteSessionByToken, isSecureRequest, userFromToken } from "@/server/auth/session";

export const POST = publicRoute(async ({ req }) => {
  // The shared parser: a malformed value counts as no session (nothing to delete), never a crash.
  const token = cookieFromHeader(req.headers.get("cookie"), SESSION_COOKIE);
  const user = await userFromToken(token);
  await deleteSessionByToken(token);
  if (user) await recordAudit(prisma, { entityType: "AUTH", entityId: user.id, action: "LOGOUT", summary: msg("authAudit.logout", { name: user.name }), actorId: user.id });
  const res = NextResponse.json({ ok: true });
  res.cookies.set({ name: SESSION_COOKIE, value: "", path: "/", httpOnly: true, sameSite: "lax", secure: isSecureRequest(req), maxAge: 0 });
  return res;
});
