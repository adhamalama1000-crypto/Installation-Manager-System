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

export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  await requirePagePermission("settings.manage");
  const [settings, statuses, people] = await Promise.all([getSettings(), listStatuses(), salesPeople({ includeInactive: true })]);
  return (
    <>
      <PageHeader title="Settings" description="System-wide options. Every change is recorded in the audit log." />
      <div className="space-y-6">
        <Card>
          <CardHeader title="General" description="Timezone, calendar and scheduling rules, role options" icon={<SlidersHorizontal className="h-4 w-4" />} />
          <CardBody>
            <GeneralSettings initial={settings} />
          </CardBody>
        </Card>
        <div className="grid gap-6 xl:grid-cols-2">
          <Card>
            <CardHeader title="Appointment statuses" description="Rename, recolour or add statuses" icon={<Tags className="h-4 w-4" />} />
            <StatusesManager statuses={statuses} />
          </Card>
          <Card>
            <CardHeader title="Sales employee colours" description="Used for calendar events and lists" icon={<Palette className="h-4 w-4" />} />
            <SalesColors people={people.filter((p) => p.role === "SALES" || p.color)} />
          </Card>
        </div>
      </div>
    </>
  );
}
