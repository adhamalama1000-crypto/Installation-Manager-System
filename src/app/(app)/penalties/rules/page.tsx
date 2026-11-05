import Link from "next/link";
import type { Metadata } from "next";
import { Card, CardHeader } from "@/components/ui/card";
import { BackArrow, PageHeader } from "@/components/ui/misc";
import { PenaltyRules } from "@/components/penalties/penalty-rules";
import { getT } from "@/i18n/server";
import { hasPermission } from "@/server/access";
import { requirePagePermission } from "@/server/auth/session";
import { listPenaltyRules } from "@/server/services/penalties";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("penalties.rules.title") };
}

export default async function PenaltyRulesPage() {
  const [user, t] = await Promise.all([requirePagePermission("penalties.view"), getT()]);
  const rules = await listPenaltyRules(user);
  return (
    <>
      <PageHeader
        breadcrumb={
          <Link href="/penalties" className="hover:text-fg">
            <BackArrow /> {t("penalties.title")}
          </Link>
        }
        title={t("penalties.rules.title")}
        description={t("penalties.rules.text")}
      />
      <Card>
        <CardHeader title={t("penalties.rules.title")} />
        <PenaltyRules rules={rules} canManage={hasPermission(user, "penalties.manage")} />
      </Card>
    </>
  );
}
