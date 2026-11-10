import type { Metadata } from "next";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/misc";
import { Pagination } from "@/components/ui/pagination";
import { ViolationTable } from "@/components/penalties/violation-table";
import { getT } from "@/i18n/server";
import { requirePagePermission } from "@/server/auth/session";
import { listViolations } from "@/server/services/penalties";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("penalties.mine") };
}

/** An employee's own decided warnings and deductions. */
export default async function MyPenaltiesPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const [user, t] = await Promise.all([requirePagePermission("penalties.own"), getT()]);
  const sp = await searchParams;
  // Only one's own, whatever else the reader may see.
  const result = await listViolations({ ...user, permissions: user.permissions.filter((p) => p !== "penalties.view" && p !== "penalties.manage" && p !== "penalties.approve") }, { page: sp.page });
  return (
    <>
      <PageHeader title={t("penalties.mine")} description={t("penalties.mineText")} />
      <Card className="overflow-hidden">
        <ViolationTable rows={result.rows} t={t} showPerson={false} empty={t("penalties.emptyMine")} />
        {result.pageCount > 1 && <Pagination page={result.page} pageCount={result.pageCount} total={result.total} hrefFor={(p) => `/penalties/mine?page=${p}`} />}
      </Card>
    </>
  );
}
