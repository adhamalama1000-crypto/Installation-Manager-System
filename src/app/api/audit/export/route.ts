import { apiRoute } from "@/server/http";
import { exportAuditCsv } from "@/server/services/audit-log";

/** The filtered audit log as CSV (Admin; the export is itself recorded). Same query as /audit. */
export const GET = apiRoute(async ({ req, user }) => {
  const p = new URL(req.url).searchParams;
  const get = (k: string) => p.get(k) ?? undefined;
  const csv = await exportAuditCsv(user, { entityType: get("entityType"), entityId: get("entityId"), module: get("module"), action: get("action"), actorId: get("actorId"), from: get("from"), to: get("to"), q: get("q") });
  return new Response(csv, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="audit-log.csv"`, "Cache-Control": "no-store" },
  });
});
