/**
 * Predefined permission templates for the permission screen. A template is a set of permissions
 * and data scopes; applying it to a person stores the difference from their role's defaults, so
 * the person's role stays what it is. Pure (shared by the server and the browser).
 */
import type { Role } from "@prisma/client";
import { MODULES, type DataScope } from "./permission-registry";
import { roleDefaults, type Permission, type PermissionSettings } from "./permissions";

export const TEMPLATE_IDS = [
  "role:SALES",
  "role:TECHNICIAN",
  "role:ACCOUNTANT",
  "role:STORE",
  "role:WAREHOUSE_MANAGER",
  "role:DRIVER",
  "salesOwnRecords",
  "teamLeader",
  "readOnly",
] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

export type Template = { id: TemplateId; permissions: Permission[]; scopes: Record<string, DataScope> };

const TEAM_MODULES = ["appointments", "customers", "complaints", "sales", "leaves", "attendance", "expenses", "penalties"];

export function templateFor(id: TemplateId, settings: PermissionSettings): Template {
  if (id.startsWith("role:")) {
    const role = id.slice(5) as Role;
    return { id, permissions: [...roleDefaults({ role }, settings)], scopes: {} };
  }
  switch (id) {
    case "salesOwnRecords":
      // A Sales employee limited to the customers, bookings and sales they handle themselves.
      return { id, permissions: [...roleDefaults({ role: "SALES" }, settings)], scopes: { appointments: "OWN", customers: "OWN", sales: "OWN", complaints: "OWN" } };
    case "teamLeader": {
      // Books and follows the team's work, approves the team's leave and sees its attendance.
      const p = new Set<Permission>(roleDefaults({ role: "SALES" }, settings));
      for (const x of ["leaves.manage", "attendance.view", "expenses.pay", "penalties.view", "complaints.manage", "board.view"] as Permission[]) p.add(x);
      return { id, permissions: [...p], scopes: Object.fromEntries(TEAM_MODULES.map((m) => [m, "TEAM" as DataScope])) };
    }
    default: {
      // Read-only: every view permission of every module except the Admin-only ones; all records.
      const permissions = MODULES.filter((m) => !m.adminOnly).flatMap((m) => m.actions.filter((a) => a.tier === 0).map((a) => a.permission));
      return { id, permissions, scopes: Object.fromEntries(MODULES.filter((m) => m.scopes?.length).map((m) => [m.id, "ALL" as DataScope])) };
    }
  }
}
