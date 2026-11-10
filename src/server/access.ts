import "server-only";
import { Prisma } from "@prisma/client";
import type { DataScope } from "@/lib/permission-registry";
import type { Permission } from "@/lib/permissions";
import type { CurrentUser } from "./auth/session";
import { ForbiddenError } from "./errors";

export function hasPermission(user: Pick<CurrentUser, "permissions">, permission: Permission): boolean {
  return user.permissions.includes(permission);
}

export function assertCan(user: Pick<CurrentUser, "permissions">, permission: Permission): void {
  if (!hasPermission(user, permission)) throw new ForbiddenError();
}

/** Any of these permissions. */
export function assertCanAny(user: Pick<CurrentUser, "permissions">, ...permissions: Permission[]): void {
  if (!permissions.some((p) => hasPermission(user, p))) throw new ForbiddenError();
}

// ---------------------------------------------------------------------------------------------
// Data scopes. Every scoped module turns the person's scope (src/lib/permission-registry.ts:
// configured by an Admin, else the role default) into the conditions below, which the services
// add to EVERY query and mutation of that module. Own = records the person created or that are
// about them; Assigned = records assigned to them; Team = those of everyone in their team (their
// own and assigned ones included; without a team, just their own and assigned ones); All = no limit.
// ---------------------------------------------------------------------------------------------

export function scopeOf(user: Pick<CurrentUser, "scopes" | "role">, module: string): DataScope {
  if (user.role === "ADMIN") return "ALL";
  return user.scopes?.[module] ?? "ALL";
}

/** Records about a person (leave, expenses, attendance, violations): which people's the reader may see. */
export function peopleScope(user: CurrentUser, module: string): Prisma.UserWhereInput {
  const scope = scopeOf(user, module);
  if (scope === "ALL") return {};
  if (scope === "TEAM" && user.teamId) return { OR: [{ id: user.id }, { teamId: user.teamId }] };
  return { id: user.id };
}

/** The same as `peopleScope`, for raw SQL over a user id column. */
export function peopleScopeSql(user: CurrentUser, module: string, userIdColumn: string): Prisma.Sql {
  const scope = scopeOf(user, module);
  const col = Prisma.raw(userIdColumn);
  if (scope === "ALL") return Prisma.sql`TRUE`;
  if (scope === "TEAM" && user.teamId) return Prisma.sql`(${col} = ${user.id} OR ${col} IN (SELECT tu.id FROM users tu WHERE tu."teamId" = ${user.teamId}))`;
  return Prisma.sql`${col} = ${user.id}`;
}

/** Whether a person's record (by their user id and team) is inside the reader's scope. */
export function inPeopleScope(user: CurrentUser, module: string, person: { id: string; teamId: string | null }): boolean {
  const scope = scopeOf(user, module);
  if (scope === "ALL" || person.id === user.id) return true;
  return scope === "TEAM" && !!user.teamId && person.teamId === user.teamId;
}

/**
 * Row-level restriction applied to EVERY appointment query. Assigned: the visits the person is a
 * technician on (drivers: the car's visits); own: the bookings they made; team: their team's
 * bookings and assignments. Users without appointments.view see nothing.
 */
export function appointmentScope(user: CurrentUser): Prisma.AppointmentWhereInput {
  if (!hasPermission(user, "appointments.view")) return { id: { in: [] } };
  const assigned: Prisma.AppointmentWhereInput = user.role === "DRIVER" ? { needsCar: true } : { technicians: { some: { technicianId: user.id } } };
  switch (scopeOf(user, "appointments")) {
    case "ALL":
      return {};
    case "ASSIGNED":
      return assigned;
    case "OWN":
      return { createdById: user.id };
    case "TEAM":
      return user.teamId
        ? { OR: [{ createdById: user.id }, assigned, { createdBy: { teamId: user.teamId } }, { technicians: { some: { technician: { teamId: user.teamId } } } }] }
        : { OR: [{ createdById: user.id }, assigned] };
  }
}

/** The same restriction as `appointmentScope`, for raw SQL over `appointments a`. Keep them in sync. */
export function appointmentScopeSql(user: CurrentUser): Prisma.Sql {
  if (!hasPermission(user, "appointments.view")) return Prisma.sql`FALSE`;
  const assigned =
    user.role === "DRIVER"
      ? Prisma.sql`a."needsCar"`
      : Prisma.sql`EXISTS (SELECT 1 FROM appointment_technicians sc WHERE sc."appointmentId" = a.id AND sc."technicianId" = ${user.id})`;
  switch (scopeOf(user, "appointments")) {
    case "ALL":
      return Prisma.sql`TRUE`;
    case "ASSIGNED":
      return assigned;
    case "OWN":
      return Prisma.sql`a."createdById" = ${user.id}`;
    case "TEAM":
      return user.teamId
        ? Prisma.sql`(a."createdById" = ${user.id} OR ${assigned}
            OR a."createdById" IN (SELECT tu.id FROM users tu WHERE tu."teamId" = ${user.teamId})
            OR EXISTS (SELECT 1 FROM appointment_technicians st JOIN users tt ON tt.id = st."technicianId" WHERE st."appointmentId" = a.id AND tt."teamId" = ${user.teamId}))`
        : Prisma.sql`(a."createdById" = ${user.id} OR ${assigned})`;
  }
}

/**
 * Customers the reader may see. A customer belongs to whoever booked their visits or sold to them
 * (own), is assigned through their visits' technicians (assigned), and to those people's team.
 */
export function customerScope(user: CurrentUser): Prisma.CustomerWhereInput {
  const scope = scopeOf(user, "customers");
  if (scope === "ALL") return {};
  const mine: Prisma.CustomerWhereInput[] = [{ appointments: { some: { createdById: user.id } } }, { salesInvoices: { some: { createdById: user.id } } }];
  const assigned: Prisma.CustomerWhereInput = { appointments: { some: { technicians: { some: { technicianId: user.id } } } } };
  if (scope === "OWN") return { OR: mine };
  if (scope === "ASSIGNED") return assigned;
  if (!user.teamId) return { OR: [...mine, assigned] };
  return {
    OR: [
      ...mine,
      assigned,
      { appointments: { some: { createdBy: { teamId: user.teamId } } } },
      { appointments: { some: { technicians: { some: { technician: { teamId: user.teamId } } } } } },
      { salesInvoices: { some: { createdBy: { teamId: user.teamId } } } },
    ],
  };
}

/** The same as `customerScope`, for raw SQL over `customers c`. */
export function customerScopeSql(user: CurrentUser): Prisma.Sql {
  const scope = scopeOf(user, "customers");
  if (scope === "ALL") return Prisma.sql`TRUE`;
  const own = Prisma.sql`(EXISTS (SELECT 1 FROM appointments oa WHERE oa."customerId" = c.id AND oa."createdById" = ${user.id})
    OR EXISTS (SELECT 1 FROM sales_invoices oi WHERE oi."customerId" = c.id AND oi."createdById" = ${user.id}))`;
  const assigned = Prisma.sql`EXISTS (SELECT 1 FROM appointments aa JOIN appointment_technicians at2 ON at2."appointmentId" = aa.id WHERE aa."customerId" = c.id AND at2."technicianId" = ${user.id})`;
  if (scope === "OWN") return own;
  if (scope === "ASSIGNED") return assigned;
  if (!user.teamId) return Prisma.sql`(${own} OR ${assigned})`;
  return Prisma.sql`(${own} OR ${assigned}
    OR EXISTS (SELECT 1 FROM appointments ta JOIN users tu ON tu.id = ta."createdById" WHERE ta."customerId" = c.id AND tu."teamId" = ${user.teamId})
    OR EXISTS (SELECT 1 FROM appointments tb JOIN appointment_technicians tt ON tt."appointmentId" = tb.id JOIN users tv ON tv.id = tt."technicianId" WHERE tb."customerId" = c.id AND tv."teamId" = ${user.teamId})
    OR EXISTS (SELECT 1 FROM sales_invoices ti JOIN users tw ON tw.id = ti."createdById" WHERE ti."customerId" = c.id AND tw."teamId" = ${user.teamId}))`;
}

/** Complaints: own = opened by the reader; assigned = assigned to them (open ones); team = their team's. */
export function complaintScopeWhere(user: CurrentUser): Prisma.ComplaintWhereInput {
  const scope = scopeOf(user, "complaints");
  const assigned: Prisma.ComplaintWhereInput = { assignedToId: user.id, status: { not: "CLOSED" } };
  if (scope === "ALL") return {};
  if (scope === "ASSIGNED") return assigned;
  if (scope === "OWN") return { createdById: user.id };
  return user.teamId
    ? { OR: [{ createdById: user.id }, assigned, { createdBy: { teamId: user.teamId } }, { assignedTo: { teamId: user.teamId } }] }
    : { OR: [{ createdById: user.id }, assigned] };
}

/** Sales invoices: own = created by the reader; team = by their team. */
export function salesScope(user: CurrentUser): Prisma.SalesInvoiceWhereInput {
  const scope = scopeOf(user, "sales");
  if (scope === "ALL") return {};
  if (scope === "TEAM" && user.teamId) return { OR: [{ createdById: user.id }, { createdBy: { teamId: user.teamId } }] };
  return { createdById: user.id };
}

/** Inventory: assigned = the reader's own vehicle only (technicians by default); all = every warehouse. */
export function vehicleScoped(user: Pick<CurrentUser, "scopes" | "role">): boolean {
  return scopeOf(user, "inventory") === "ASSIGNED";
}
