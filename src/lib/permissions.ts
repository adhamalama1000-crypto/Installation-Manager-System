/**
 * Role-based permissions. This module is pure so the same rules drive both the server-side
 * enforcement (src/server/access.ts, every API route and query) and the UI (which only hides
 * actions the server would refuse anyway).
 */
import type { Role } from "@prisma/client";

export const PERMISSIONS = [
  /** See appointments. Technicians are additionally restricted to their own assignments. */
  "appointments.view",
  /** Create, edit, reschedule, assign technicians, change status, cancel. */
  "appointments.manage",
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
  /** Stock by serial number. Technicians only see the items they hold. */
  "stock.view",
  /** Register goods in, hand items to technicians, take them back, mark returned / faulty; models and warranty. */
  "stock.manage",
  "reports.view",
  "users.manage",
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
};

export function permissionsFor(user: PermissionSubject, settings: PermissionSettings): Set<Permission> {
  if (user.isActive === false) return new Set();
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
      ];
      if (settings.salesCanViewReports) p.push("reports.view");
      return new Set(p);
    }
    case "TECHNICIAN": {
      const p: Permission[] = ["appointments.view", "location.view", "visits.report", "leaves.request", "stock.view", "complaints.view", "checkins.record", "expenses.record"];
      if (settings.technicianCanSeeContacts) p.push("customers.contact");
      return new Set(p);
    }
    case "ACCOUNTANT":
      return new Set<Permission>(["appointments.view", "customers.view", "customers.contact", "finance.view", "cash.receive", "stock.view", "attendance.view", "expenses.pay"]);
    case "DRIVER":
      // Sees only the visits the car serves (see access.ts), to drop and pick up the teams.
      return new Set<Permission>(["appointments.view", "location.view", "customers.contact", "route.view", "car.checkin", "expenses.record"]);
    case "STORE":
      return new Set<Permission>(["appointments.view", "stock.view", "stock.manage"]);
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
