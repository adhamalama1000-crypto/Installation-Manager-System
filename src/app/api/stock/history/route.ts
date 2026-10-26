import { apiRoute } from "@/server/http";
import { itemHistory } from "@/server/services/stock";

export const GET = apiRoute(async ({ req, user }) => itemHistory(user, new URL(req.url).searchParams.get("serial") ?? ""));
