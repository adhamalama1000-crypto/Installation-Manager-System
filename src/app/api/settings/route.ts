import { assertCan } from "@/server/access";
import { apiRoute, readJson } from "@/server/http";
import { getSettings, updateSettings } from "@/server/services/settings";

export const GET = apiRoute(async ({ user }) => {
  assertCan(user, "settings.manage");
  return { settings: await getSettings() };
});

export const PUT = apiRoute(async ({ req, user }) => ({ settings: await updateSettings(user, await readJson(req)) }));
