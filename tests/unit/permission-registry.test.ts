import { describe, expect, it } from "vitest";
import { ADMIN_ONLY_PERMISSIONS, MODULES, defaultScope, levelOf, levelsOf, permissionsForLevel, scopeOverrides, scopesFor, viewerMayHold } from "@/lib/permission-registry";
import { templateFor, TEMPLATE_IDS } from "@/lib/permission-templates";
import { PERMISSIONS, overridesFor, permissionsFor, roleDefaults } from "@/lib/permissions";

const settings = { salesCanViewReports: true, technicianCanSeeContacts: true };
const mod = (id: string) => MODULES.find((m) => m.id === id)!;

describe("permission registry", () => {
  it("places every permission in exactly one module, and nothing else", () => {
    const listed = MODULES.flatMap((m) => m.actions.map((a) => a.permission));
    expect([...listed].sort()).toEqual([...PERMISSIONS].sort());
    expect(new Set(listed).size).toBe(listed.length);
  });

  it("keeps users, settings and the audit log for Admins only", () => {
    expect([...ADMIN_ONLY_PERMISSIONS].sort()).toEqual(["audit.view", "settings.manage", "users.manage"]);
  });

  it("builds levels from the actions' tiers, and recognises a custom set", () => {
    const appts = mod("appointments");
    expect(permissionsForLevel(appts, "none")).toEqual([]);
    expect(permissionsForLevel(appts, "view")).toEqual(["appointments.view", "location.view", "notes.internal", "history.view"]);
    expect(permissionsForLevel(appts, "viewCreate")).toContain("appointments.create");
    expect(permissionsForLevel(appts, "viewCreateEdit")).toEqual(expect.arrayContaining(["appointments.manage", "appointments.assign"]));
    expect(permissionsForLevel(appts, "full")).toEqual(expect.arrayContaining(["appointments.cancel", "appointments.export"]));
    expect(levelOf(appts, new Set(permissionsForLevel(appts, "viewCreate")))).toBe("viewCreate");
    expect(levelOf(appts, new Set(["appointments.view", "appointments.export"]))).toBe("custom");
    expect(levelOf(appts, new Set())).toBe("none");
    // Products has no separate create action: "view + create" is the same as "view only".
    expect(levelsOf(mod("products"))).toEqual(["none", "view", "viewCreateEdit", "full"]);
  });

  it("reproduces the old fixed scopes as role defaults", () => {
    const tech = { role: "TECHNICIAN" as const, permissions: roleDefaults({ role: "TECHNICIAN" }, settings) };
    const sales = { role: "SALES" as const, permissions: roleDefaults({ role: "SALES" }, settings) };
    const accountant = { role: "ACCOUNTANT" as const, permissions: roleDefaults({ role: "ACCOUNTANT" }, settings) };
    expect(defaultScope("appointments", tech)).toBe("ASSIGNED");
    expect(defaultScope("complaints", tech)).toBe("ASSIGNED");
    expect(defaultScope("inventory", tech)).toBe("ASSIGNED");
    expect(defaultScope("appointments", { role: "DRIVER", permissions: [] })).toBe("ASSIGNED");
    expect(defaultScope("appointments", sales)).toBe("ALL");
    expect(defaultScope("leaves", sales)).toBe("OWN");
    expect(defaultScope("expenses", accountant)).toBe("ALL");
    expect(defaultScope("penalties", accountant)).toBe("ALL");
    expect(defaultScope("penalties", tech)).toBe("OWN");
    // Admins: everything, whatever is stored.
    expect(Object.values(scopesFor({ role: "ADMIN", permissions: new Set() }, { appointments: "OWN" })).every((s) => s === "ALL")).toBe(true);
  });

  it("applies configured scopes only where the module offers them, and stores only differences", () => {
    const sales = { role: "SALES" as const, permissions: roleDefaults({ role: "SALES" }, settings) };
    const s = scopesFor(sales, { appointments: "OWN", inventory: "TEAM", nonsense: "ALL", sales: "BAD" });
    expect(s.appointments).toBe("OWN");
    expect(s.inventory).toBe("ALL"); // inventory offers ASSIGNED / ALL only
    expect(s.sales).toBe("ALL");
    expect(scopeOverrides(sales, { appointments: "ALL", customers: "OWN", leaves: "OWN" })).toEqual({ customers: "OWN" });
  });
});

describe("effective permissions", () => {
  it("adds grants and removes denials on top of the role", () => {
    const p = permissionsFor({ role: "SALES", permissionGrants: ["leaves.manage"], permissionDenies: ["appointments.cancel", "appointments.export"] }, settings);
    expect(p.has("leaves.manage")).toBe(true);
    expect(p.has("appointments.cancel")).toBe(false);
    expect(p.has("appointments.create")).toBe(true);
    expect(p.has("appointments.export")).toBe(false);
  });

  it("never gives Admin-only permissions to anyone else, and keeps Viewers read-only", () => {
    const sales = permissionsFor({ role: "SALES", permissionGrants: ["users.manage", "audit.view", "settings.manage", "nonsense.perm"] }, settings);
    expect(sales.has("users.manage") || sales.has("audit.view") || sales.has("settings.manage")).toBe(false);
    expect([...sales].every((x) => (PERMISSIONS as readonly string[]).includes(x))).toBe(true);
    const viewer = permissionsFor({ role: "VIEWER", viewerPermissions: ["appointments.view"], permissionGrants: ["appointments.manage", "customers.view", "inventory.reports", "sales.void"] }, settings);
    expect([...viewer].sort()).toEqual(["appointments.export", "appointments.view", "customers.view", "inventory.reports"]);
    expect(viewerMayHold("appointments.manage")).toBe(false);
    expect(viewerMayHold("products.export")).toBe(true);
  });

  it("Admins always have everything; inactive people nothing", () => {
    expect(permissionsFor({ role: "ADMIN", permissionDenies: ["users.manage"] }, settings).size).toBe(PERMISSIONS.length);
    expect(permissionsFor({ role: "SALES", isActive: false, permissionGrants: ["leaves.manage"] }, settings).size).toBe(0);
  });

  it("stores the difference from the role, and that difference gives back the wanted set", () => {
    const wanted = [...roleDefaults({ role: "TECHNICIAN" }, settings)].filter((p) => p !== "appointments.export").concat(["board.view"]);
    const { grants, denies } = overridesFor({ role: "TECHNICIAN" }, settings, wanted);
    expect(grants).toEqual(["board.view"]);
    expect(denies).toEqual(["appointments.export"]);
    expect([...permissionsFor({ role: "TECHNICIAN", permissionGrants: grants, permissionDenies: denies }, settings)].sort()).toEqual([...wanted].sort());
  });
});

describe("templates", () => {
  it("are defined for every id and never include Admin-only permissions", () => {
    for (const id of TEMPLATE_IDS) {
      const t = templateFor(id, settings);
      expect(t.permissions.some((p) => (ADMIN_ONLY_PERMISSIONS as string[]).includes(p))).toBe(false);
    }
  });
  it("limit a Sales employee to their own records, give a team leader team scopes, and read-only only views", () => {
    expect(templateFor("salesOwnRecords", settings).scopes).toMatchObject({ appointments: "OWN", customers: "OWN", sales: "OWN" });
    const leader = templateFor("teamLeader", settings);
    expect(leader.permissions).toEqual(expect.arrayContaining(["leaves.manage", "attendance.view"]));
    expect(leader.scopes.leaves).toBe("TEAM");
    const ro = templateFor("readOnly", settings);
    expect(ro.permissions).toContain("appointments.view");
    expect(ro.permissions).not.toContain("appointments.manage");
    expect(ro.permissions.every((p) => MODULES.some((m) => m.actions.some((a) => a.permission === p && a.tier === 0)))).toBe(true);
  });
});
