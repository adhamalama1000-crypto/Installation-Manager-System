import { apiRoute, readJson } from "@/server/http";
import { receiveCash } from "@/server/services/payments";

export const POST = apiRoute(async ({ req, user }) => receiveCash(user, await readJson(req)));
