import { apiRoute, readJson } from "@/server/http";
import { payExpenses } from "@/server/services/expenses";

/** Body: { userId, month: "YYYY-MM" }: pays that person's pending expenses of the month. */
export const POST = apiRoute(async ({ req, user }) => payExpenses(user, await readJson(req)));
