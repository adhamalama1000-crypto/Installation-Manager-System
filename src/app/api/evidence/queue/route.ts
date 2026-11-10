import { apiRoute } from "@/server/http";
import { reviewQueue } from "@/server/services/evidence";

/** ?status=SUBMITTED (default) | REJECTED | APPROVED: visits whose latest review event is that. */
export const GET = apiRoute(async ({ req, user }) => {
  const s = new URL(req.url).searchParams.get("status");
  return { rows: await reviewQueue(user, s === "REJECTED" || s === "APPROVED" ? s : "SUBMITTED") };
});
