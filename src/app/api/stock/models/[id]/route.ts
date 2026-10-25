import { apiRoute, readJson } from "@/server/http";
import { saveModel } from "@/server/services/stock";

export const PATCH = apiRoute(async ({ req, user, params }) => saveModel(user, params.id!, await readJson(req)));
