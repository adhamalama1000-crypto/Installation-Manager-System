import type { Metadata } from "next";
import { Palette, SlidersHorizontal, Tags } from "lucide-react";
import { GeneralSettings } from "@/components/settings/general-settings";
import { SalesColors } from "@/components/settings/sales-colors";
import { StatusesManager } from "@/components/settings/statuses-manager";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/misc";
import { getI18n } from "@/i18n/server";
import { requirePagePermission } from "@/server/auth/session";
import { getSettings } from "@/server/services/settings";
import { listStatuses } from "@/server/services/statuses";
import { salesPeople } from "@/server/services/users";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getI18n()).t("set.title") };
}

export default async function SettingsPage() {
  await requirePagePermission("settings.manage");
  const [settings, statuses, people, { t }] = await Promise.all([getSettings(), listStatuses(), salesPeople({ includeInactive: true }), getI18n()]);
  return (
    <>
      <PageHeader title={t("set.title")} description={t("set.desc")} />
      <div className="space-y-6">
        <Card>
          <CardHeader title={t("set.general")} description={t("set.generalDesc")} icon={<SlidersHorizontal className="h-4 w-4" />} />
          <CardBody>
            <GeneralSettings initial={settings} />
          </CardBody>
        </Card>
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <Card>
            <CardHeader title={t("set.statuses")} description={t("set.statusesDesc")} icon={<Tags className="h-4 w-4" />} />
            <StatusesManager statuses={statuses} />
          </Card>
          <Card>
            <CardHeader title={t("set.salesColours")} description={t("set.salesColoursDesc")} icon={<Palette className="h-4 w-4" />} />
            <SalesColors people={people.filter((p) => p.role === "SALES" || p.color)} />
          </Card>
        </div>
      </div>
    </>
  );
}
