import { apiRoute, readJson } from "@/server/http";
import { setQualityGrade } from "@/server/services/after-sales";

export const PUT = apiRoute(async ({ req, user, params }) => setQualityGrade(user, params.id!, await readJson(req)));
