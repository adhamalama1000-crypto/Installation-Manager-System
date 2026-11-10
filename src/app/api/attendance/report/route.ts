import { apiRoute } from "@/server/http";
import { attendanceRange } from "@/server/services/attendance";

/** Query: from, to (YYYY-MM-DD, at most 63 days), userId. Staff see their own days only. */
export const GET = apiRoute(async ({ req, user }) => {
  const p = new URL(req.url).searchParams;
  return attendanceRange(user, p.get("from") ?? undefined, p.get("to") ?? undefined, { userId: p.get("userId") ?? undefined });
});
