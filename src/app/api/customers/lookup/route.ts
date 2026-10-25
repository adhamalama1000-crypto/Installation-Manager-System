import { apiRoute } from "@/server/http";
import { lookupCustomers } from "@/server/services/customers";

export const GET = apiRoute(async ({ req, user }) => ({
  customers: await lookupCustomers(user, new URL(req.url).searchParams.get("q") ?? ""),
}));
