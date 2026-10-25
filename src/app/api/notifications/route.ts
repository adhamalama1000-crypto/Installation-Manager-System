import { apiRoute } from "@/server/http";
import { listNotifications } from "@/server/services/notifications";

export const GET = apiRoute(async ({ user }) => listNotifications(user));
