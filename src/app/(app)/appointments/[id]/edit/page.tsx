import Link from "next/link";
import { redirect } from "next/navigation";
import { AppointmentForm } from "@/components/appointments/appointment-form";
import { valuesFromAppointment } from "@/components/appointments/form-values";
import { PageHeader } from "@/components/ui/misc";
import { prisma } from "@/server/db";
import { requirePagePermission } from "@/server/auth/session";
import { getAppointment } from "@/server/services/appointments";
import { listStatuses } from "@/server/services/statuses";
import { loadOr404 } from "../load";

export const metadata = { title: "Edit appointment" };

export default async function EditAppointmentPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePagePermission("appointments.manage");
  const { id } = await params;
  const appt = await loadOr404(() => getAppointment(user, id));
  if (!appt.canManage) redirect("/access-denied");
  const tz = user.settings.timezone;
  const [technicians, statuses, locations] = await Promise.all([
    prisma.user.findMany({
      where: { role: "TECHNICIAN", OR: [{ isActive: true }, { id: { in: appt.technicians.map((t) => t.id) } }] },
      select: { id: true, name: true, isActive: true },
      orderBy: { name: "asc" },
    }),
    listStatuses(),
    prisma.customerLocation.findMany({ where: { customerId: appt.customer.id }, orderBy: { updatedAt: "desc" } }),
  ]);
  return (
    <>
      <PageHeader
        title={`Edit ${appt.code}`}
        breadcrumb={
          <Link href={`/appointments/${appt.id}`} className="hover:text-fg">
            ← Back to appointment
          </Link>
        }
        description="Changes are checked against technician schedules and recorded in the history."
      />
      <AppointmentForm
        mode="edit"
        appointmentId={appt.id}
        version={appt.version}
        initial={valuesFromAppointment(appt, tz)}
        technicians={technicians}
        statuses={statuses}
        currentUserId={user.id}
        canSeeInternalNotes={user.permissions.includes("notes.internal")}
        tz={tz}
        originalCreator={appt.createdBy}
        closedWeekdays={user.settings.closedWeekdays}
        isAdmin={user.role === "ADMIN"}
        initialLocations={locations.map((l) => ({
          id: l.id,
          area: l.area,
          streetAddress: l.streetAddress,
          building: l.building,
          apartment: l.apartment,
          floor: l.floor,
          accessInstructions: l.accessInstructions,
          mapUrl: l.mapUrl,
          latitude: l.latitude?.toNumber() ?? null,
          longitude: l.longitude?.toNumber() ?? null,
        }))}
      />
    </>
  );
}
