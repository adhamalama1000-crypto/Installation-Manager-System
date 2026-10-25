import { apiRoute } from "@/server/http";
import { createPasswordLink } from "@/server/services/users";

export const POST = apiRoute(async ({ user, params }) => ({ link: await createPasswordLink(user, params.id!) }));
