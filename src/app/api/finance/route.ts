import { apiRoute } from "@/server/http";
import { financeStatement, parseMonth } from "@/server/services/payments";

export const GET = apiRoute(async ({ req, user }) =>
  financeStatement(user, parseMonth(new URL(req.url).searchParams.get("month"), user.settings.timezone)),
);
