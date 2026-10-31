import { Palette, SlidersHorizontal, Tags } from "lucide-react";
import { GeneralSettings } from "@/components/settings/general-settings";
import { SalesColors } from "@/components/settings/sales-colors";
import { StatusesManager } from "@/components/settings/statuses-manager";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/misc";
import { requirePagePermission } from "@/server/auth/session";
import { getSettings } from "@/server/services/settings";
import { listStatuses } from "@/server/services/statuses";
import { salesPeople } from "@/server/services/users";
import { getT } from "@/i18n/server";
import type { Metadata } from "next";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("nav.settings") };
}

export default async function SettingsPage() {
  const [, t] = await Promise.all([requirePagePermission("settings.manage"), getT()]);
  const [settings, statuses, people] = await Promise.all([getSettings(), listStatuses(t.locale), salesPeople({ includeInactive: true })]);
  return (
    <>
      <PageHeader title={t("nav.settings")} description={t("settings.text")} />
      <div className="space-y-6">
        <Card>
          <CardHeader title={t("settings.general")} description={t("settings.generalText")} icon={<SlidersHorizontal className="h-4 w-4" />} />
          <CardBody>
            <GeneralSettings initial={settings} />
          </CardBody>
        </Card>
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <Card>
            <CardHeader title={t("settings.statuses")} description={t("settings.statusesText")} icon={<Tags className="h-4 w-4" />} />
            <StatusesManager statuses={statuses} />
          </Card>
          <Card>
            <CardHeader title={t("settings.colors")} description={t("settings.colorsText")} icon={<Palette className="h-4 w-4" />} />
            <SalesColors people={people.filter((p) => p.role === "SALES" || p.color)} />
          </Card>
        </div>
      </div>
    </>
  );
}
