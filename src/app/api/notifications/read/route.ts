import { z } from "zod";
import { apiRoute, readJson } from "@/server/http";
import { markNotificationsRead } from "@/server/services/notifications";

const schema = z.object({ ids: z.array(z.string().max(64)).max(100).optional() });

export const POST = apiRoute(async ({ req, user }) => {
  const parsed = schema.safeParse(await readJson(req));
  await markNotificationsRead(user, parsed.success ? parsed.data.ids : undefined);
  return { ok: true };
});
