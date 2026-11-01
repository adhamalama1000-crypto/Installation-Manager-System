import { apiRoute, readJson } from "@/server/http";
import { previewQuote } from "@/server/services/quotes";

/** Body: { url }: reads a quotation from the company website for the booking form. */
export const POST = apiRoute(async ({ req, user }) => ({ quote: await previewQuote(user, await readJson(req)) }));
