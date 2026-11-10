/**
 * Every permission of the system, organised by module (the pages of the app) and action. The
 * permission screen is generated from this list and a unit test fails if a permission key is not
 * in it, so a new module can never be left out. Pure: shared by the server and the browser.
 *
 * Action kinds are the standard columns of the permission matrix. Approve covers approve and reject
 * (one decision). The system never hard-deletes business records (bookings are cancelled, documents
 * reversed, people and products deactivated), so destructive actions appear as "archive".
 */
import type { Role } from "@prisma/client";
import type { Permission } from "./permissions";

export const ACTION_KINDS = ["view", "create", "edit", "delete", "archive", "approve", "export", "assign", "manage", "special"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

/** How far a permission reaches: what the levels "view only", "view + create", ... include. */
export type Tier = 0 | 1 | 2 | 3;

export const DATA_SCOPES = ["OWN", "ASSIGNED", "TEAM", "ALL"] as const;
export type DataScope = (typeof DATA_SCOPES)[number];

export type ModuleAction = {
  kind: ActionKind;
  permission: Permission;
  /** 0 view, 1 create, 2 edit, 3 full only (archive, approve, export, assign, settings). */
  tier: Tier;
  /** Message key suffix under `permRegistry.special.` for a named action (kind "special" or a refinement). */
  label?: string;
};

export type ModuleDef = {
  id: string;
  /** Pages this module covers (for the screen and the docs). */
  pages: string[];
  actions: ModuleAction[];
  /** Data scopes this module offers (none: the permission alone decides). */
  scopes?: readonly DataScope[];
  /** Only the Admin role may hold these permissions (never granted to anyone else). */
  adminOnly?: boolean;
};

const a = (kind: ActionKind, permission: Permission, tier: Tier, label?: string): ModuleAction => ({ kind, permission, tier, ...(label ? { label } : {}) });

export const MODULES: ModuleDef[] = [
  {
    id: "appointments",
    pages: ["/", "/appointments", "/calendar", "/appointments/new", "/day-plan"],
    actions: [
      a("view", "appointments.view", 0),
      a("special", "location.view", 0, "viewLocation"),
      a("special", "notes.internal", 0, "viewInternalNotes"),
      a("special", "history.view", 0, "viewHistory"),
      a("create", "appointments.create", 1),
      a("edit", "appointments.manage", 2),
      a("assign", "appointments.assign", 2),
      a("archive", "appointments.cancel", 3),
      a("export", "appointments.export", 3),
    ],
    scopes: ["OWN", "ASSIGNED", "TEAM", "ALL"],
  },
  { id: "customers", pages: ["/customers"], actions: [a("view", "customers.view", 0), a("special", "customers.contact", 0, "viewContact")], scopes: ["OWN", "ASSIGNED", "TEAM", "ALL"] },
  { id: "visits", pages: ["/appointments/[id]"], actions: [a("create", "checkins.record", 1, "checkIn"), a("edit", "visits.report", 2, "reportOutcome")] },
  { id: "board", pages: ["/board"], actions: [a("view", "board.view", 0)] },
  { id: "route", pages: ["/route"], actions: [a("view", "route.view", 0), a("create", "car.checkin", 1, "carCheckIn"), a("edit", "route.manage", 2, "orderStops")] },
  { id: "complaints", pages: ["/complaints"], actions: [a("view", "complaints.view", 0), a("edit", "complaints.manage", 2)], scopes: ["OWN", "ASSIGNED", "TEAM", "ALL"] },
  { id: "afterSales", pages: ["/after-sales"], actions: [a("approve", "quality.grade", 2, "gradeQuality")] },
  { id: "workReview", pages: ["/evidence"], actions: [a("approve", "evidence.review", 3)] },
  { id: "leaves", pages: ["/leaves"], actions: [a("create", "leaves.request", 1, "requestLeave"), a("approve", "leaves.manage", 3)], scopes: ["OWN", "TEAM", "ALL"] },
  { id: "attendance", pages: ["/attendance", "/attendance/daily", "/attendance/clock"], actions: [a("view", "attendance.view", 0), a("approve", "attendance.manage", 3, "reviewAttendance")], scopes: ["OWN", "TEAM", "ALL"] },
  { id: "expenses", pages: ["/expenses"], actions: [a("create", "expenses.record", 1), a("approve", "expenses.pay", 3, "payExpenses")], scopes: ["OWN", "TEAM", "ALL"] },
  { id: "finance", pages: ["/finance"], actions: [a("view", "finance.view", 0), a("edit", "cash.receive", 2, "receiveCash"), a("export", "finance.export", 3)] },
  { id: "reports", pages: ["/reports"], actions: [a("view", "reports.view", 0), a("export", "reports.export", 3)] },
  { id: "serialCustody", pages: ["/inventory"], actions: [a("view", "stock.view", 0), a("edit", "stock.manage", 2)] },
  { id: "products", pages: ["/products"], actions: [a("view", "products.view", 0), a("edit", "products.manage", 2, "createEditImport"), a("export", "products.export", 3)] },
  { id: "warehouses", pages: ["/warehouses"], actions: [a("view", "warehouses.view", 0), a("edit", "warehouses.manage", 2)] },
  {
    id: "inventory",
    pages: ["/stock", "/stock/documents", "/stock/movements", "/stocktakes"],
    actions: [
      a("view", "inventory.view", 0),
      a("create", "inventory.receive", 1, "receive"),
      a("create", "inventory.issue", 1, "issue"),
      a("create", "inventory.transfer", 1, "transfer"),
      a("create", "inventory.count", 1, "count"),
      a("approve", "inventory.approve", 3),
      a("export", "inventory.reports", 3, "costsAndExports"),
    ],
    scopes: ["ASSIGNED", "ALL"],
  },
  { id: "suppliers", pages: ["/suppliers"], actions: [a("view", "suppliers.view", 0), a("edit", "suppliers.manage", 2)] },
  { id: "sales", pages: ["/sales"], actions: [a("view", "sales.view", 0), a("create", "sales.manage", 1, "createConfirm"), a("archive", "sales.void", 3, "voidSale")], scopes: ["OWN", "TEAM", "ALL"] },
  { id: "analytics", pages: ["/analytics"], actions: [a("view", "analytics.view", 0)] },
  {
    id: "penalties",
    pages: ["/penalties", "/penalties/mine"],
    actions: [a("special", "penalties.own", 0, "seeOwn"), a("view", "penalties.view", 0), a("edit", "penalties.manage", 2, "recordViolations"), a("approve", "penalties.approve", 3)],
    scopes: ["OWN", "TEAM", "ALL"],
  },
  { id: "users", pages: ["/users"], actions: [a("manage", "users.manage", 3)], adminOnly: true },
  { id: "settings", pages: ["/settings"], actions: [a("manage", "settings.manage", 3)], adminOnly: true },
  { id: "audit", pages: ["/audit"], actions: [a("view", "audit.view", 0)], adminOnly: true },
];

export type ModuleId = (typeof MODULES)[number]["id"];
export const SCOPED_MODULES = MODULES.filter((m) => m.scopes?.length).map((m) => m.id);

const BY_PERMISSION = new Map<string, { module: ModuleDef; action: ModuleAction }>();
for (const m of MODULES) for (const x of m.actions) BY_PERMISSION.set(x.permission, { module: m, action: x });

export function moduleOf(permission: string): ModuleDef | undefined {
  return BY_PERMISSION.get(permission)?.module;
}

export function actionOf(permission: string): ModuleAction | undefined {
  return BY_PERMISSION.get(permission)?.action;
}

/** Permissions only the Admin role may hold. */
export const ADMIN_ONLY_PERMISSIONS: Permission[] = MODULES.filter((m) => m.adminOnly).flatMap((m) => m.actions.map((x) => x.permission));

/** A Viewer is read-only: it may receive view (tier 0) and export permissions only. */
export function viewerMayHold(permission: string): boolean {
  const x = actionOf(permission);
  return !!x && !moduleOf(permission)?.adminOnly && (x.tier === 0 || x.kind === "export");
}

// ---------------------------------------------------------------------------------------------
// Levels (the per-module presets of the permission screen)
// ---------------------------------------------------------------------------------------------

export const LEVELS = ["none", "view", "viewCreate", "viewCreateEdit", "full"] as const;
export type Level = (typeof LEVELS)[number] | "custom";

const LEVEL_TIER: Record<(typeof LEVELS)[number], number> = { none: -1, view: 0, viewCreate: 1, viewCreateEdit: 2, full: 3 };

/** The permissions a level gives in a module. */
export function permissionsForLevel(m: ModuleDef, level: (typeof LEVELS)[number]): Permission[] {
  return m.actions.filter((x) => x.tier <= LEVEL_TIER[level]).map((x) => x.permission);
}

/** The lowest level that gives exactly these permissions in a module ("custom" when none does). */
export function levelOf(m: ModuleDef, held: ReadonlySet<string>): Level {
  const mine = new Set(m.actions.filter((x) => held.has(x.permission)).map((x) => x.permission));
  for (const level of LEVELS) {
    const want = permissionsForLevel(m, level);
    if (want.length === mine.size && want.every((p) => mine.has(p))) return level;
  }
  return "custom";
}

/** The levels that differ from each other in this module (a module without a create action has no "view + create"). */
export function levelsOf(m: ModuleDef): (typeof LEVELS)[number][] {
  const out: (typeof LEVELS)[number][] = [];
  let last = "";
  for (const l of LEVELS) {
    const key = permissionsForLevel(m, l).join(",");
    if (key !== last || l === "none") out.push(l);
    last = key;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Data scopes
// ---------------------------------------------------------------------------------------------

export type ScopeSubject = { role: Role; permissions: ReadonlySet<string> | readonly string[] };

/**
 * The scope a role has by default in a module: exactly what the system did before scopes were
 * configurable (technicians: their assigned visits and complaints, their own vehicle; people who
 * manage leave, expenses, attendance or violations: everyone's; others: their own).
 */
export function defaultScope(module: string, subject: ScopeSubject): DataScope {
  const has = (p: string) => (subject.permissions instanceof Set ? subject.permissions.has(p) : (subject.permissions as readonly string[]).includes(p));
  if (subject.role === "ADMIN") return "ALL";
  switch (module) {
    case "appointments":
      return subject.role === "TECHNICIAN" || subject.role === "DRIVER" ? "ASSIGNED" : "ALL";
    case "complaints":
      return subject.role === "TECHNICIAN" ? "ASSIGNED" : "ALL";
    case "inventory":
      return subject.role === "TECHNICIAN" ? "ASSIGNED" : "ALL";
    case "leaves":
      return has("leaves.manage") ? "ALL" : "OWN";
    case "expenses":
      return has("expenses.pay") ? "ALL" : "OWN";
    case "attendance":
      return has("attendance.view") || has("attendance.manage") ? "ALL" : "OWN";
    case "penalties":
      return has("penalties.view") ? "ALL" : "OWN";
    default:
      return "ALL";
  }
}

/** Effective scopes: the configured ones (valid for their module) over the role defaults; Admin: all. */
export function scopesFor(subject: ScopeSubject, configured: unknown): Record<string, DataScope> {
  const out: Record<string, DataScope> = {};
  const conf = configured && typeof configured === "object" && !Array.isArray(configured) ? (configured as Record<string, unknown>) : {};
  for (const m of MODULES) {
    if (!m.scopes?.length) continue;
    const c = conf[m.id];
    out[m.id] = subject.role === "ADMIN" ? "ALL" : typeof c === "string" && (m.scopes as readonly string[]).includes(c) ? (c as DataScope) : defaultScope(m.id, subject);
  }
  return out;
}

/** Only the scopes that differ from the role default are stored. */
export function scopeOverrides(subject: ScopeSubject, wanted: Record<string, string>): Record<string, DataScope> {
  const out: Record<string, DataScope> = {};
  for (const m of MODULES) {
    const w = wanted[m.id];
    if (!m.scopes?.length || typeof w !== "string" || !(m.scopes as readonly string[]).includes(w)) continue;
    if (w !== defaultScope(m.id, subject)) out[m.id] = w as DataScope;
  }
  return out;
}
