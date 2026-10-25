import { NextResponse } from "next/server";
import { publicRoute } from "@/server/http";
import { SESSION_COOKIE, deleteSessionByToken, secureCookies } from "@/server/auth/session";

export const POST = publicRoute(async ({ req }) => {
  const cookie = req.headers.get("cookie") ?? "";
  const token = cookie
    .split(";")
    .map((p) => p.trim())
    .find((p) => p.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
  await deleteSessionByToken(token ? decodeURIComponent(token) : null);
  const res = NextResponse.json({ ok: true });
  res.cookies.set({ name: SESSION_COOKIE, value: "", path: "/", httpOnly: true, sameSite: "lax", secure: secureCookies(), maxAge: 0 });
  return res;
});
