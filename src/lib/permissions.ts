/**
 * Role-based permissions. This module is pure so the same rules drive both the server-side
 * enforcement (src/server/access.ts, every API route and query) and the UI (which only hides
 * actions the server would refuse anyway).
 */
import type { Role } from "@prisma/client";
import { ADMIN_ONLY_PERMISSIONS, viewerMayHold } from "./permission-registry";

export const PERMISSIONS = [
  /** See appointments. Technicians are additionally restricted to their own assignments. */
  "appointments.view",
  /** Edit and reschedule bookings, change their status (and the booking-office tools: day plan, quotes). */
  "appointments.manage",
  /** Book new appointments. */
  "appointments.create",
  /** Cancel (archive) bookings, with a reason. */
  "appointments.cancel",
  /** Assign and change the technicians of a booking. */
  "appointments.assign",
  /** Export the appointment list (CSV). */
  "appointments.export",
  /** Customer directory pages. */
  "customers.view",
  /** Customer phone numbers. */
  "customers.contact",
  /** Address, apartment, floor, access instructions and map link. */
  "location.view",
  /** Internal company notes. */
  "notes.internal",
  /** Change history of an appointment. */
  "history.view",
  /** Record the outcome of an assigned visit (start, done, unable, needs another visit) with a report. */
  "visits.report",
  /** Ask for leave, sick leave or a day off (own requests only). */
  "leaves.request",
  /** Approve, reject, add and cancel leave for any technician. */
  "leaves.manage",
  /** Monthly finance statement: sales, deposits, collections, balances owed, cash held. */
  "finance.view",
  /** Confirm that cash a technician collected was handed over. */
  "cash.receive",
  /** Export the monthly finance statement (CSV). */
  "finance.export",
  /** Stock by serial number. Technicians only see the items they hold. */
  "stock.view",
  /** Register goods in, hand items to technicians, take them back, mark returned / faulty; models and warranty. */
  "stock.manage",
  /** Reports pages. */
  "reports.view",
  /** Export reports (CSV). */
  "reports.export",
  /** Users, roles, individual permissions, data scopes and teams (Admin only). */
  "users.manage",
  /** System settings (Admin only). */
  "settings.manage",
  /** System-wide audit log. */
  "audit.view",
  /** Customer complaints. Technicians only see the ones assigned to them. */
  "complaints.view",
  /** Assign complaints to a technician and link the maintenance visit (head of installations). */
  "complaints.manage",
  /** Grade the quality of finished work (head of installations). */
  "quality.grade",
  /** Check in at the company and at visits with the phone's location (technicians, for themselves). */
  "checkins.record",
  /** Live board of where every technician is today (also for the office screen). */
  "board.view",
  /** Monthly attendance and points of every technician. */
  "attendance.view",
  /** Record one's own transport expenses (technicians and the driver). */
  "expenses.record",
  /** See everyone's transport expenses and pay them out (accountant). */
  "expenses.pay",
  /** The company car's route for a day. */
  "route.view",
  /** The car's check-ins: left the company, dropped a team, picked a team up, back (driver). */
  "car.checkin",
  /** Change the order of the car's stops (head of installations). */
  "route.manage",
  // ERP inventory (warehouses, stock ledger, stock documents, stocktakes).
  /** Product catalogue (read). */
  "products.view",
  /** Create and edit products, units, categories and brands. */
  "products.manage",
  /** Export the product catalogue (Excel). */
  "products.export",
  /** Warehouses, technicians' vehicles and bins (read). */
  "warehouses.view",
  /** Create and edit warehouses, vehicles and bins, including the negative-stock policy. */
  "warehouses.manage",
  /** Stock balances, stock documents and the ledger. Technicians only see their own vehicle. */
  "inventory.view",
  /** Goods receipts and customer returns. */
  "inventory.receive",
  /** Stock issues and supplier returns. */
  "inventory.issue",
  /** Transfers between warehouses and bins. */
  "inventory.transfer",
  /** Physical stocktakes (start, count, submit) and adjustment drafts. */
  "inventory.count",
  /** Approve stocktakes, post adjustments and opening balances, cancel posted documents. */
  "inventory.approve",
  /** Stock valuation, costs and inventory exports. */
  "inventory.reports",
  // ERP upgrade.
  /** Supplier master (read). */
  "suppliers.view",
  /** Create and edit suppliers. */
  "suppliers.manage",
  /** Sales invoices (read). */
  "sales.view",
  /** Prepare and confirm sales invoices (confirming issues the stock). */
  "sales.manage",
  /** Cancel a confirmed sale (reverses its stock issue; needs a reason). */
  "sales.void",
  /** Sales and product analytics: rankings, trends, turnover, valuation. */
  "analytics.view",
  /** Review flagged check-ins (outside the geofence, no location), approved work locations, geofences. */
  "attendance.manage",
  /** Approve or reject the work evidence technicians submit for a visit. */
  "evidence.review",
  /** See everyone's violations and deductions. */
  "penalties.view",
  /** Record violations and set the penalty rules. */
  "penalties.manage",
  /** Approve, reject or cancel violations and deductions (only approved deductions reach finance). */
  "penalties.approve",
  /** See one's own violations and deductions (employees). */
  "penalties.own",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** Permissions an Admin may grant to individual Viewer accounts. */
export const VIEWER_GRANTABLE: Permission[] = [
  "appointments.view",
  "customers.view",
  "customers.contact",
  "location.view",
  "notes.internal",
  "history.view",
  "reports.view",
  "complaints.view",
  "board.view",
  "route.view",
  "products.view",
  "warehouses.view",
  "inventory.view",
  "inventory.reports",
  "suppliers.view",
  "sales.view",
  "analytics.view",
];

export const DEFAULT_VIEWER_PERMISSIONS: Permission[] = ["appointments.view"];

/** Settings that adjust role permissions (managed by Admin in Settings). */
export type PermissionSettings = {
  salesCanViewReports: boolean;
  technicianCanSeeContacts: boolean;
};

export type PermissionSubject = {
  role: Role;
  viewerPermissions?: string[] | null;
  isActive?: boolean;
  /** Individual permissions added to the role's (set by an Admin on the permission screen). */
  permissionGrants?: string[] | null;
  /** Individual permissions removed from the role's. */
  permissionDenies?: string[] | null;
};

const ALL = new Set<string>(PERMISSIONS);

/**
 * Actions that got their own permission later are implied by the permission that covered them
 * before, in the role defaults only, so nobody gains or loses anything by the change; an Admin can
 * still remove each one individually.
 */
const IMPLIED: [Permission, Permission[]][] = [
  ["appointments.manage", ["appointments.create", "appointments.cancel", "appointments.assign"]],
  ["appointments.view", ["appointments.export"]],
  ["reports.view", ["reports.export"]],
  ["finance.view", ["finance.export"]],
  ["products.view", ["products.export"]],
];

/** What a role has before any individual change (the template the permission screen starts from). */
export function roleDefaults(user: Pick<PermissionSubject, "role" | "viewerPermissions">, settings: PermissionSettings): Set<Permission> {
  const base = roleBase(user, settings);
  for (const [from, to] of IMPLIED) if (base.has(from)) for (const p of to) base.add(p);
  return base;
}

/**
 * Effective permissions: the role's, plus the individual grants, minus the individual denials.
 * Admins always have everything. Admin-only permissions (users, settings, audit log) are never
 * given to anyone else, and a Viewer only ever holds view and export permissions, whatever is
 * stored. Inactive users have none.
 */
export function permissionsFor(user: PermissionSubject, settings: PermissionSettings): Set<Permission> {
  if (user.isActive === false) return new Set();
  if (user.role === "ADMIN") return new Set(PERMISSIONS);
  const out = roleDefaults(user, settings);
  for (const g of user.permissionGrants ?? []) if (ALL.has(g)) out.add(g as Permission);
  for (const d of user.permissionDenies ?? []) out.delete(d as Permission);
  for (const p of ADMIN_ONLY_PERMISSIONS) out.delete(p);
  if (user.role === "VIEWER") for (const p of [...out]) if (!viewerMayHold(p)) out.delete(p);
  return out;
}

/** The individual changes that turn a role's defaults into the wanted set (what is stored). */
export function overridesFor(user: Pick<PermissionSubject, "role" | "viewerPermissions">, settings: PermissionSettings, wanted: Iterable<string>): { grants: Permission[]; denies: Permission[] } {
  const base = roleDefaults(user, settings);
  const want = new Set([...wanted].filter((p) => ALL.has(p)));
  return {
    grants: PERMISSIONS.filter((p) => want.has(p) && !base.has(p)),
    denies: PERMISSIONS.filter((p) => base.has(p) && !want.has(p)),
  };
}

function roleBase(user: Pick<PermissionSubject, "role" | "viewerPermissions">, settings: PermissionSettings): Set<Permission> {
  switch (user.role) {
    case "ADMIN":
      return new Set(PERMISSIONS);
    case "SALES": {
      const p: Permission[] = [
        "appointments.view",
        "appointments.manage",
        "customers.view",
        "customers.contact",
        "location.view",
        "notes.internal",
        "history.view",
        "complaints.view",
        "products.view",
        "sales.view",
        "sales.manage",
        "penalties.own",
      ];
      if (settings.salesCanViewReports) p.push("reports.view", "analytics.view");
      return new Set(p);
    }
    case "TECHNICIAN": {
      const p: Permission[] = ["appointments.view", "location.view", "visits.report", "leaves.request", "stock.view", "complaints.view", "checkins.record", "expenses.record", "inventory.view", "penalties.own"];
      if (settings.technicianCanSeeContacts) p.push("customers.contact");
      return new Set(p);
    }
    case "ACCOUNTANT":
      return new Set<Permission>([
        "appointments.view", "customers.view", "customers.contact", "finance.view", "cash.receive", "stock.view", "attendance.view", "expenses.pay",
        "products.view", "warehouses.view", "inventory.view", "inventory.reports",
        "suppliers.view", "sales.view", "sales.void", "analytics.view", "penalties.view", "penalties.own",
      ]);
    case "DRIVER":
      // Sees only the visits the car serves (see access.ts), to drop and pick up the teams.
      return new Set<Permission>(["appointments.view", "location.view", "customers.contact", "route.view", "car.checkin", "expenses.record", "penalties.own"]);
    case "STORE":
      return new Set<Permission>([
        "appointments.view", "stock.view", "stock.manage",
        "products.view", "warehouses.view", "inventory.view", "inventory.receive", "inventory.issue", "inventory.transfer", "inventory.count",
        "suppliers.view", "penalties.own",
      ]);
    case "WAREHOUSE_MANAGER":
      return new Set<Permission>([
        "appointments.view", "stock.view", "stock.manage",
        "products.view", "products.manage", "warehouses.view", "warehouses.manage",
        "inventory.view", "inventory.receive", "inventory.issue", "inventory.transfer", "inventory.count", "inventory.approve", "inventory.reports",
        "suppliers.view", "suppliers.manage", "sales.view", "analytics.view", "penalties.own",
      ]);
    case "VIEWER": {
      const granted = (user.viewerPermissions ?? []).filter((p): p is Permission =>
        (VIEWER_GRANTABLE as string[]).includes(p),
      );
      return new Set(granted);
    }
  }
}

export function can(user: PermissionSubject, permission: Permission, settings: PermissionSettings): boolean {
  return permissionsFor(user, settings).has(permission);
}

/** Technicians only ever see appointments they are assigned to (drivers: the car's visits). */
export function isAssignmentScoped(role: Role): boolean {
  return role === "TECHNICIAN" || role === "DRIVER";
}

/** Technicians see only the stock of their own vehicle (warehouse of kind VEHICLE linked to them). */
export function isVehicleScoped(role: Role): boolean {
  return role === "TECHNICIAN";
}

/** Purchase and average costs, stock value: hidden from people who only move stock. */
export function canSeeCosts(perms: Set<Permission>): boolean {
  return perms.has("inventory.reports") || perms.has("products.manage") || perms.has("inventory.approve");
}
