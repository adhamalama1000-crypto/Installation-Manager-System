import { NextResponse } from "next/server";
import { msg } from "@/i18n/translator";
import { prisma } from "@/server/db";
import { recordAudit } from "@/server/services/audit";
import { publicRoute } from "@/server/http";
import { SESSION_COOKIE, deleteSessionByToken, isSecureRequest, userFromToken } from "@/server/auth/session";

export const POST = publicRoute(async ({ req }) => {
  const cookie = req.headers.get("cookie") ?? "";
  const token = cookie
    .split(";")
    .map((p) => p.trim())
    .find((p) => p.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
  const user = await userFromToken(token ? decodeURIComponent(token) : null);
  await deleteSessionByToken(token ? decodeURIComponent(token) : null);
  if (user) await recordAudit(prisma, { entityType: "AUTH", entityId: user.id, action: "LOGOUT", summary: msg("authAudit.logout", { name: user.name }), actorId: user.id });
  const res = NextResponse.json({ ok: true });
  res.cookies.set({ name: SESSION_COOKIE, value: "", path: "/", httpOnly: true, sameSite: "lax", secure: isSecureRequest(req), maxAge: 0 });
  return res;
});
