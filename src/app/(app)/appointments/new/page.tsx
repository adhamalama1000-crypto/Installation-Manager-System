import { AppointmentForm } from "@/components/appointments/appointment-form";
import { emptyValues } from "@/components/appointments/form-values";
import { PageHeader } from "@/components/ui/misc";
import { isValidDateString, todayKey, TIME_RE } from "@/lib/time";
import { requirePagePermission } from "@/server/auth/session";
import { activeTechnicians, salesPeople } from "@/server/services/users";
import { listStatuses } from "@/server/services/statuses";

export const metadata = { title: "New appointment" };

export default async function NewAppointmentPage({ searchParams }: { searchParams: Promise<{ date?: string; time?: string }> }) {
  const user = await requirePagePermission("appointments.manage");
  const sp = await searchParams;
  const tz = user.settings.timezone;
  const [technicians, statuses, sales] = await Promise.all([
    activeTechnicians(),
    listStatuses(),
    user.role === "ADMIN" ? salesPeople() : Promise.resolve(null),
  ]);
  const defaultStatus = statuses.find((s) => s.isDefault && s.isActive) ?? statuses.find((s) => s.isActive);
  const initial = emptyValues({
    date: sp.date && isValidDateString(sp.date) ? sp.date : todayKey(tz),
    durationMinutes: user.settings.defaultDurationMinutes,
    statusId: defaultStatus?.id ?? "",
    salesUserId: user.id,
  });
  if (sp.time && TIME_RE.test(sp.time)) initial.startTime = sp.time;
  return (
    <>
      <PageHeader title="New appointment" description="Book an installation and assign available technicians." />
      <AppointmentForm
        mode="create"
        initial={initial}
        technicians={technicians}
        statuses={statuses}
        salesOptions={sales?.filter((s) => s.role === "SALES" || s.id === user.id).map((s) => ({ id: s.id, name: s.name, color: s.color }))}
        currentUserId={user.id}
        canSeeInternalNotes={user.permissions.includes("notes.internal")}
        tz={tz}
      />
    </>
  );
}
