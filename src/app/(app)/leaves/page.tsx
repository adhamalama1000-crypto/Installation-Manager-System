import { redirect } from "next/navigation";
import { LeavesManager } from "@/components/leaves/leaves-manager";
import { PageHeader } from "@/components/ui/misc";
import { requireUser } from "@/server/auth/session";
import { leaveOverview } from "@/server/services/leaves";
import { activeTechnicians } from "@/server/services/users";
import { getT } from "@/i18n/server";
import type { Metadata } from "next";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("nav.leave") };
}

export default async function LeavesPage() {
  const [user, t] = await Promise.all([requireUser(), getT()]);
  const manage = user.permissions.includes("leaves.manage");
  if (!manage && !user.permissions.includes("leaves.request")) redirect("/access-denied");
  const [overview, technicians] = await Promise.all([leaveOverview(user), manage ? activeTechnicians() : Promise.resolve([])]);
  return (
    <>
      <PageHeader
        title={manage ? t("leaves.manageTitle") : t("nav.myLeave")}
        description={manage ? t("leaves.manageText") : t("leaves.ownText")}
      />
      <LeavesManager overview={overview} technicians={technicians.map((x) => ({ id: x.id, name: x.name }))} manage={manage} timezone={user.settings.timezone} />
    </>
  );
}
