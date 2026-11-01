import { msg } from "@/i18n/translator";
import { ValidationError } from "@/server/errors";
import { apiRoute } from "@/server/http";
import { REPORT_TYPES, reportCsv, type ReportType } from "@/server/services/reports";

export const GET = apiRoute(async ({ req, user }) => {
  const params = new URL(req.url).searchParams;
  const type = params.get("type") ?? "appointments";
  if (!(REPORT_TYPES as readonly string[]).includes(type)) throw new ValidationError({ type: msg("reportErrors.unknownType") });
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  const csv = await reportCsv(user, type as ReportType, { from, to });
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${type}-${from}-to-${to}.csv"`,
      "Cache-Control": "no-store",
    },
  });
});
