# Permissions and audit log: audit and implementation plan

Audit of `main` at `094911e` (after the ERP upgrade, PR #17), done by reading the code before any
change. The goal: per-user permissions for every module and action, data scopes, a permission
management screen, and a complete, immutable audit log, built on the existing architecture.

## 1. What exists

### Permissions
- **One permission table** in `src/lib/permissions.ts`: 52 permission keys (`module.action` strings),
  8 roles, `permissionsFor(user, settings)` returns the role's set; two settings widen roles (Sales
  reports, technicians' phone numbers); Viewers get individual grants from `VIEWER_GRANTABLE`
  (stored in `users.viewerPermissions`).
- **Loaded once per request** in `userFromToken` (session, user and settings in one SQL statement);
  inactive users get no permissions.
- **Server enforcement**: `assertCan` / `hasPermission` (`src/server/access.ts`) inside every service
  function; pages call `requirePagePermission`; every API route is wrapped by `apiRoute`
  (same-origin check, session, JSON errors). 224 checks across the services.
- **Record scopes are hard-coded by role**: `appointmentScope` / `appointmentScopeSql` (technicians:
  assigned visits; drivers: car visits), complaints (technicians: assigned), inventory (technicians:
  own vehicle, `isVehicleScoped`), leave / expenses / attendance / violations ("own" unless the
  person holds the managing permission), Sales editing others' bookings (a setting).
- **Escalation guards**: only `users.manage` (Admin) edits users; an Admin cannot deactivate or demote
  themselves; the last active Admin is protected; a role or permission sent by the browser is ignored.

### Audit log
- `audit_logs` (entity type, entity id, action, summary in English + message key, field changes,
  actor, visit) with an **append-only trigger** (`audit_logs_no_update_delete`, since the first
  migration). `recordAudit(tx, …)` writes inside the business transaction. `/audit` page (Admin,
  `audit.view`) filters by text, record type, person and dates.
- Writes with an audit entry: bookings, statuses, users, settings, customers' feedback, complaints,
  leave, cash, stock and inventory documents, products, warehouses, stocktakes, suppliers, sales,
  attendance, evidence, violations.

## 2. Gaps found

| Area | Gap |
|---|---|
| Per-user permissions | Only Viewers can be given individual permissions; every other user gets exactly their role. No per-module levels, no custom action sets, no templates, no copy, no reset, no effective-permission review. |
| Action granularity | `appointments.manage` covers create, edit, cancel, assign technicians and export alike; exports are not separate permissions (appointments, reports, finance, attendance and product exports follow the view or report permission). |
| Data scopes | Not configurable: scopes are fixed by role. No "team" concept exists at all (no teams table, no team membership). |
| Escalation | Nothing stops a future custom grant of `users.manage`, `settings.manage` or `audit.view` to a non-Admin; no rule that a person can never change their own permissions (only role / activation are guarded). |
| Audit: sign-in | Sign-ins, failed sign-ins and sign-outs are only in `login_attempts` (deleted after a day, failures cleared on success), not in the audit log. |
| Audit: exports | CSV / Excel exports (appointments, reports, finance, inventory, products, attendance) are not recorded. |
| Audit: context | No module, no request context (IP, user agent, method, path), no reason column. |
| Audit: attendance | Company arrival / leaving from the dashboard quick buttons and car day check-ins are not in the audit log (the clock page's are). |
| Audit: corrections | No way to record an administrative correction of history other than writing new business records. |
| Audit page | No filters by module, action or entity id; `FINANCE` entries cannot be filtered. |
| Audit integrity | UPDATE and DELETE are blocked by trigger; TRUNCATE is not (needs the table owner, i.e. a database administrator). |

## 3. Design (extends what exists; no second permission system)

**Permission keys stay the unit of authorization.** Everything that already checks `hasPermission`
keeps working. New keys are added only where an action needs its own switch:
`appointments.create`, `appointments.cancel` (archive), `appointments.assign`, `appointments.export`,
`reports.export`, `finance.export`, `attendance.export`, `products.export`. Role defaults give these to
exactly the people who could do the action before, so nobody gains or loses access by the upgrade.

**A registry** (`src/lib/permission-registry.ts`) groups every key into a module (page) and an action
(view, create, edit, delete, archive, approve / reject, export, assign, manage settings, or a named
special action such as "view phone numbers"). The permission screen is generated from it, and a unit
test fails if any permission key is missing from the registry, so new modules cannot be forgotten.

**Per-user overrides** on top of the role: `users.permissionGrants`, `users.permissionDenies`
(text arrays, like the existing `viewerPermissions`) and `users.dataScopes` (JSON, module → scope).
Effective permissions = (role defaults ∪ grants) − denies, computed in the same per-request SQL
statement as today (no extra query). Admin is always everything (overrides ignored).

**Data scopes** per module: Own, Assigned, Team, All (each module offers the ones that make sense).
Role defaults reproduce today's behaviour (technicians: assigned visits and complaints, own vehicle;
others: all). A new `teams` table and `users.teamId` give "team" a meaning. One server helper turns a
module's scope into the Prisma / SQL conditions each service already applies.

**Escalation rules (server-side):** only the Admin role manages users, roles, permissions, scopes and
teams; nobody changes their own role, permissions, scopes, team or activation; `users.manage`,
`settings.manage` and `audit.view` are Admin-only and are stripped from any other role even if stored;
Viewers can only receive view and export permissions; every change is audited with old and new values.

**Audit log:** additive columns `module`, `reason`, `context` (IP, user agent, method, path); request
context captured once in `apiRoute` / `publicRoute` (AsyncLocalStorage) so every existing
`recordAudit` call gets it without changes; module derived from the entity type; sign-in, failed
sign-in, blocked sign-in and sign-out events; export events; attendance check-ins from every entry
point; administrative corrections as new `AUDIT_CORRECTION` events with a required reason; filters by
person, module, action, record type, record id and dates; secrets never written (a sanitiser drops
password / token / hash fields from change sets).

## 4. Database changes (one additive migration)

- `teams` (new table); `users.teamId` (nullable FK).
- `users.permissionGrants`, `users.permissionDenies` (`TEXT[] DEFAULT '{}'`), `users.dataScopes`
  (`JSONB`, nullable).
- `audit_logs.module`, `audit_logs.reason` (nullable text), `audit_logs.context` (nullable JSONB), and
  indexes for the new filters.
- No existing column, row, constraint or trigger changes; the append-only trigger stays.

## 5. Phases

1. Registry, migration, effective permissions, escalation guards.
2. Server enforcement: new action permissions in the services and routes; configurable scopes in
   appointments (Prisma and SQL), customers, complaints, sales, leave, expenses, attendance,
   violations and inventory.
3. Users screen: permission matrix by module with levels and custom actions, scopes, templates, copy
   from a user, reset, effective permissions, teams; Arabic and English.
4. Audit log: columns, context, sign-in / export / attendance / permission events, corrections, filters.
5. Tests (unit, integration, API, browser), documentation, full regression on a fresh database.
