import { apiRoute, readJson } from "@/server/http";
import { saveQuote } from "@/server/services/quotes";

/** Body: { url }: reads the quotation and keeps it on the visit. */
export const POST = apiRoute(async ({ req, user, params }) => ({ quote: await saveQuote(user, params.id!, await readJson(req)) }));
