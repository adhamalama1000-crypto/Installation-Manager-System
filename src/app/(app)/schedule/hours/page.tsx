import Link from "next/link";
import type { Metadata } from "next";
import { CalendarDays } from "lucide-react";
import { buttonClasses } from "@/components/ui/button";
import { EmptyState, PageHeader } from "@/components/ui/misc";
import { WorkHoursEditor } from "@/components/schedule/work-hours-editor";
import { getT } from "@/i18n/server";
import { dateTime } from "@/lib/format";
import { requirePagePermission } from "@/server/auth/session";
import { listWorkHours } from "@/server/services/work-hours";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("workHours.title") };
}

/** Technicians' working hours (schedule.manage). Bookings outside them need an override with a reason. */
export default async function WorkHoursPage() {
  const [user, t] = await Promise.all([requirePagePermission("schedule.manage"), getT()]);
  const rows = await listWorkHours();
  const tz = user.settings.timezone;
  return (
    <>
      <PageHeader
        title={t("workHours.title")}
        description={t("workHours.text")}
        actions={
          user.permissions.includes("schedule.global") && (
            <Link href="/schedule" className={buttonClasses("outline", "sm")}>
              <CalendarDays className="h-4 w-4" /> {t("companySchedule.title")}
            </Link>
          )
        }
      />
      {rows.length === 0 ? (
        <EmptyState title={t("companySchedule.noTechnicians")} />
      ) : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {rows.map((r) => (
            <WorkHoursEditor
              key={r.id}
              technician={{ id: r.id, name: r.name }}
              days={r.days}
              configured={r.configured}
              updated={r.updatedAt ? t("workHours.updated", { name: r.updatedBy ?? "", when: dateTime(r.updatedAt, tz, t.locale) }) : null}
              weekStartsOn={user.settings.weekStartsOn}
            />
          ))}
        </div>
      )}
    </>
  );
}
