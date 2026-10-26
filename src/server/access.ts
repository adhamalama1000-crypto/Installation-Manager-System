import "server-only";
import { Prisma } from "@prisma/client";
import type { Permission } from "@/lib/permissions";
import type { CurrentUser } from "./auth/session";
import { ForbiddenError } from "./errors";

export function hasPermission(user: Pick<CurrentUser, "permissions">, permission: Permission): boolean {
  return user.permissions.includes(permission);
}

export function assertCan(user: Pick<CurrentUser, "permissions">, permission: Permission): void {
  if (!hasPermission(user, permission)) throw new ForbiddenError();
}

/**
 * Row-level restriction applied to EVERY appointment query. Technicians only see appointments
 * they are assigned to; users without appointments.view see nothing.
 */
export function appointmentScope(user: CurrentUser): Prisma.AppointmentWhereInput {
  if (!hasPermission(user, "appointments.view")) return { id: { in: [] } };
  if (user.role === "TECHNICIAN") return { technicians: { some: { technicianId: user.id } } };
  return {};
}

/** The same restriction as `appointmentScope`, for raw SQL over `appointments a`. Keep them in sync. */
export function appointmentScopeSql(user: CurrentUser): Prisma.Sql {
  if (!hasPermission(user, "appointments.view")) return Prisma.sql`FALSE`;
  if (user.role === "TECHNICIAN") {
    return Prisma.sql`EXISTS (SELECT 1 FROM appointment_technicians sc WHERE sc."appointmentId" = a.id AND sc."technicianId" = ${user.id})`;
  }
  return Prisma.sql`TRUE`;
}
