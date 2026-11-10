import { apiRoute, readJson } from "@/server/http";
import { listEvidenceRules, saveEvidenceRule } from "@/server/services/evidence";

export const GET = apiRoute(async ({ user }) => ({ rules: await listEvidenceRules(user) }));

/** Body: { visitType, productCategory ('' = any), minBeforePhotos, minAfterPhotos, require…, isActive }. Creates or replaces that rule. */
export const PUT = apiRoute(async ({ req, user }) => ({ rule: await saveEvidenceRule(user, await readJson(req)) }));
