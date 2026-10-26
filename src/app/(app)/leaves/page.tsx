import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { LeavesManager } from "@/components/leaves/leaves-manager";
import { PageHeader } from "@/components/ui/misc";
import { getI18n } from "@/i18n/server";
import { requireUser } from "@/server/auth/session";
import { leaveOverview } from "@/server/services/leaves";
import { activeTechnicians } from "@/server/services/users";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getI18n()).t("nav.leave") };
}

export default async function LeavesPage() {
  const user = await requireUser();
  const manage = user.permissions.includes("leaves.manage");
  if (!manage && !user.permissions.includes("leaves.request")) redirect("/access-denied");
  const { t } = await getI18n();
  const [overview, technicians] = await Promise.all([leaveOverview(user), manage ? activeTechnicians() : Promise.resolve([])]);
  return (
    <>
      <PageHeader
        title={manage ? t("leave.titleManage") : t("leave.titleOwn")}
        description={manage ? t("leave.descManage") : t("leave.descOwn")}
      />
      <LeavesManager overview={overview} technicians={technicians.map((t) => ({ id: t.id, name: t.name }))} manage={manage} />
    </>
  );
}
