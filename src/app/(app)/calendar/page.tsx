import type { Metadata } from "next";
import { CalendarView, type CalendarViewMode } from "@/components/calendar/calendar-view";
import { PageHeader } from "@/components/ui/misc";
import { getI18n } from "@/i18n/server";
import { isValidDateString, todayKey } from "@/lib/time";
import { prisma } from "@/server/db";
import { requirePagePermission } from "@/server/auth/session";
import { listStatuses } from "@/server/services/statuses";
import { salesPeople } from "@/server/services/users";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getI18n()).t("cal.title") };
}

const VIEWS: CalendarViewMode[] = ["month", "week", "day", "agenda"];

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; date?: string; salesId?: string; technicianId?: string; status?: string }>;
}) {
  const user = await requirePagePermission("appointments.view");
  const sp = await searchParams;
  const tech = user.role === "TECHNICIAN";
  const [sales, technicians, statuses] = await Promise.all([
    salesPeople({ includeInactive: true }),
    tech ? Promise.resolve([]) : prisma.user.findMany({ where: { role: "TECHNICIAN" }, select: { id: true, name: true, isActive: true }, orderBy: [{ isActive: "desc" }, { name: "asc" }] }),
    listStatuses(),
  ]);
  const s = user.settings;
  const { t } = await getI18n();
  return (
    <>
      <PageHeader
        title={tech ? t("cal.titleTech") : t("cal.title")}
        description={tech ? t("cal.descTech") : t("cal.desc")}
      />
      <CalendarView
        tz={s.timezone}
        weekStartsOn={s.weekStartsOn}
        dayStartHour={s.dayStartHour}
        dayEndHour={s.dayEndHour}
        initialView={VIEWS.includes(sp.view as CalendarViewMode) ? (sp.view as CalendarViewMode) : null}
        initialDate={sp.date && isValidDateString(sp.date) ? sp.date : todayKey(s.timezone)}
        initialFilters={{ salesId: sp.salesId, technicianId: sp.technicianId, status: sp.status }}
        sales={sales.filter((p) => p.role === "SALES" || p.isActive)}
        technicians={technicians}
        statuses={statuses}
        canCreate={user.permissions.includes("appointments.manage")}
        isTechnician={tech}
      />
    </>
  );
}
