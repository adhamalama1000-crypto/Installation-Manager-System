import { apiRoute } from "@/server/http";
import { recordExport } from "@/server/services/audit";
import { exportBalancesCsv, exportLedgerCsv } from "@/server/services/inventory-stock";

/** Query: kind (balances | ledger) and the same filters as the lists. Needs inventory.reports. */
export const GET = apiRoute(async ({ req, user }) => {
  const p = new URL(req.url).searchParams;
  const get = (k: string) => p.get(k) ?? undefined;
  const kind = p.get("kind") === "ledger" ? "ledger" : "balances";
  const csv =
    kind === "ledger"
      ? await exportLedgerCsv(user, { productId: get("productId"), warehouseId: get("warehouseId"), type: get("type"), q: get("q"), from: get("from"), to: get("to") })
      : await exportBalancesCsv(user, { view: get("view"), warehouseId: get("warehouseId"), q: get("q"), categoryId: get("categoryId"), low: get("low") });
  await recordExport(user, kind, "INVENTORY", { kind, filters: Object.fromEntries(p) });
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="stock-${kind}-${new Date().toISOString().slice(0, 10)}.csv"`,
      "Cache-Control": "no-store",
    },
  });
});
