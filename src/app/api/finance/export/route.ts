import { apiRoute } from "@/server/http";
import { localeFromRequest } from "@/i18n/server";
import { financeCsv, parseMonth } from "@/server/services/payments";

export const GET = apiRoute(async ({ req, user }) => {
  const month = parseMonth(new URL(req.url).searchParams.get("month"), user.settings.timezone);
  const csv = await financeCsv(user, month, localeFromRequest(req, user.locale));
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="finance-${month}.csv"`,
      "Cache-Control": "no-store",
    },
  });
});
