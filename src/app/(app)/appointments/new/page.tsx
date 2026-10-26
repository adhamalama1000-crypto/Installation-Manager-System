import { AppointmentForm, type SavedLocation } from "@/components/appointments/appointment-form";
import { emptyValues } from "@/components/appointments/form-values";
import { PageHeader } from "@/components/ui/misc";
import { isValidDateString, todayKey, TIME_RE } from "@/lib/time";
import { prisma } from "@/server/db";
import { requirePagePermission } from "@/server/auth/session";
import { NotFoundError } from "@/server/errors";
import { getAppointment } from "@/server/services/appointments";
import { activeTechnicians, salesPeople } from "@/server/services/users";
import { listStatuses } from "@/server/services/statuses";

export const metadata = { title: "New appointment" };

export default async function NewAppointmentPage({ searchParams }: { searchParams: Promise<{ date?: string; time?: string; followUp?: string }> }) {
  const user = await requirePagePermission("appointments.manage");
  const sp = await searchParams;
  const tz = user.settings.timezone;
  const [technicians, statuses, sales, original] = await Promise.all([
    activeTechnicians(),
    listStatuses(),
    user.role === "ADMIN" ? salesPeople() : Promise.resolve(null),
    // A follow-up visit starts from the earlier appointment's customer, site and product.
    sp.followUp ? getAppointment(user, sp.followUp).catch((e) => (e instanceof NotFoundError ? null : Promise.reject(e))) : Promise.resolve(null),
  ]);
  const defaultStatus = statuses.find((s) => s.isDefault && s.isActive) ?? statuses.find((s) => s.isActive);
  const initial = emptyValues({
    date: sp.date && isValidDateString(sp.date) ? sp.date : todayKey(tz),
    durationMinutes: user.settings.defaultDurationMinutes,
    statusId: defaultStatus?.id ?? "",
    salesUserId: user.id,
  });
  if (sp.time && TIME_RE.test(sp.time)) initial.startTime = sp.time;
  let locations: SavedLocation[] = [];
  if (original) {
    const loc = original.location;
    Object.assign(initial, {
      followUpOfId: original.id,
      visitType: original.visitType ?? "",
      productCategory: original.productCategory,
      categoryOther: original.categoryOther ?? "",
      brand: original.brand ?? "",
      model: original.model ?? "",
      description: original.description ?? "",
      requiredEquipment: original.requiredEquipment ?? "",
      additionalNotes: original.additionalNotes ?? "",
      customer: { id: original.customer.id, name: original.customer.name, phone: original.customer.phone ?? "", secondaryPhone: original.customer.secondaryPhone ?? "" },
    });
    if (loc) {
      initial.location = {
        id: loc.id,
        area: loc.area ?? "",
        streetAddress: loc.streetAddress ?? "",
        building: loc.building ?? "",
        apartment: loc.apartment ?? "",
        floor: loc.floor ?? "",
        accessInstructions: loc.accessInstructions ?? "",
        mapUrl: loc.mapUrl ?? "",
        latitude: loc.latitude != null ? String(loc.latitude) : "",
        longitude: loc.longitude != null ? String(loc.longitude) : "",
      };
    }
    locations = (await prisma.customerLocation.findMany({ where: { customerId: original.customer.id }, orderBy: { updatedAt: "desc" } })).map((l) => ({
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
    }));
  }
  return (
    <>
      <PageHeader
        title={original ? `Follow-up visit for ${original.code}` : "New appointment"}
        description="Book an installation and assign available technicians."
      />
      <AppointmentForm
        mode="create"
        initial={initial}
        technicians={technicians}
        statuses={statuses}
        salesOptions={sales?.filter((s) => s.role === "SALES" || s.id === user.id).map((s) => ({ id: s.id, name: s.name, color: s.color }))}
        currentUserId={user.id}
        canSeeInternalNotes={user.permissions.includes("notes.internal")}
        tz={tz}
        closedWeekdays={user.settings.closedWeekdays}
        isAdmin={user.role === "ADMIN"}
        followUpOf={original ? { id: original.id, code: original.code } : undefined}
        initialLocations={locations}
      />
    </>
  );
}
