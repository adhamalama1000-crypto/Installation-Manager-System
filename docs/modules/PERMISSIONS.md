# Permissions

## 1. Module purpose

Decide, for every person, every module and every action, what they may see and do and **which
records** they may see, and enforce it **on the server** for every page, API route and service
function; the interface only hides what the server would refuse anyway. An Admin has authority over
everything; nobody can raise their own access.

## 2. How users operate it

- **Role.** Admins set each user's role in *Users*. The role gives a set of default permissions and
  default record scopes (sections 4 and 5).
- **Individual permissions.** *Users → Permissions* (`/users/[id]/access`) opens the permission
  matrix of one person: one row per module, grouped by module, with
  - a **level**: *No access*, *View only*, *View + create*, *View + create + edit*, *Full access*,
    or *Custom* when the ticks do not match a level;
  - a column per **action** (View, Create, Edit, Delete, Archive, Approve/Reject, Export, Assign,
    Manage settings) and an *Other* column for module-specific rights (for example phone numbers,
    internal notes, record outcome); each box is one permission and can be ticked on its own;
  - a **Records** column (data scope) where the module has records that belong to people:
    *Own records*, *Assigned records*, *Team records* or *All records*.
  A dot marks rows that differ from the role's defaults. *Save permissions* takes an optional
  reason, which is stored in the audit log.
- **Team.** The person's team (for *Team records*). Teams are created and renamed in *Users → Teams*;
  they are deactivated, never deleted. A deactivated team no longer gives its members team
  visibility (they keep their own and assigned records), and cannot be given to anyone.
- **Templates.** *Like a Sales employee*, *Like a technician*, *Like an accountant*, *Like a store
  keeper*, *Like a warehouse manager*, *Like a driver*, *Sales: own customers and records only*,
  *Team leader (team records)*, *Read-only, all modules*. Applying one replaces the person's permissions and scopes (after a confirmation).
- **Copy from** another person (same result as their effective permissions and scopes).
- **Reset to role defaults** removes every individual change.
- **Effective permissions** lists everything the person may do now and where each right comes from
  (*Role* or *Added*), and what was *Removed* from the role.
- Changing a person's **role** clears their individual changes (the new role's defaults apply).
- Admins' own matrix is read-only (they always have everything); one's own matrix is read-only for
  everybody (another Admin must change it).

Two settings still change role defaults: *Sales can view reports* (adds `reports.view`,
`reports.export` and `analytics.view` to Sales) and *Technicians can see customer phone numbers*
(adds `customers.contact` to technicians); **both are on by default**. Viewer accounts keep their
read-only check boxes in the user form; the matrix can add other read-only rights to them.

A page someone may not open redirects to *Access denied*; an API call returns 401 (not signed in),
403 (no right) or 404 (a record outside their scope).

## 3. Available features

- One registry of every permission, grouped by **module** and **action kind**, shared by the server
  and the interface (`src/lib/permission-registry.ts`). The matrix is generated from it, and a unit
  test fails when a permission is not placed in a module, so new modules cannot be left out.
- Effective permissions = role defaults + individual **grants** − individual **denies**, computed on
  every request from the database (`permissionsFor`), so a change applies on the person's next click
  without signing in again; deactivation removes everything at once.
- **Data scopes** per module, applied in the database queries (section 5).
- Teams, templates, copy, reset, effective-permission review, all audited.
- Hard limits that no stored value can lift: `users.manage`, `settings.manage` and `audit.view` are
  Admin-only; Viewers can only hold view and export rights; Admins always hold everything and see
  all records.

## 4. Roles and permissions

What each permission allows (from the comments in `src/lib/permissions.ts`):

| Permission | Allows |
|---|---|
| `appointments.view` | See appointments. Technicians are additionally restricted to their own assignments. |
| `appointments.manage` | Edit and reschedule bookings, change their status (and the booking-office tools: day plan, quotes). |
| `appointments.create` | Book new appointments. |
| `appointments.cancel` | Cancel (archive) bookings, with a reason. |
| `appointments.assign` | Assign and change the technicians of a booking. |
| `appointments.export` | Export the appointment list (CSV). |
| `customers.view` | Customer directory pages. |
| `customers.contact` | Customer phone numbers. |
| `location.view` | Address, apartment, floor, access instructions and map link. |
| `notes.internal` | Internal company notes. |
| `history.view` | Change history of an appointment. |
| `visits.report` | Record the outcome of an assigned visit (start, done, unable, needs another visit) with a report. |
| `leaves.request` | Ask for leave, sick leave or a day off (own requests only). |
| `leaves.manage` | Approve, reject, add and cancel leave for any technician. |
| `finance.view` | Monthly finance statement: sales, deposits, collections, balances owed, cash held. |
| `cash.receive` | Confirm that cash a technician collected was handed over. |
| `finance.export` | Export the monthly finance statement (CSV). |
| `stock.view` | Stock by serial number. Technicians only see the items they hold. |
| `stock.manage` | Register goods in, hand items to technicians, take them back, mark returned / faulty; models and warranty. |
| `reports.view` | Reports pages. |
| `reports.export` | Export reports (CSV). |
| `users.manage` | Users, roles, individual permissions, data scopes and teams (Admin only). |
| `settings.manage` | System settings (Admin only). |
| `audit.view` | System-wide audit log. |
| `complaints.view` | Customer complaints. Technicians only see the ones assigned to them. |
| `complaints.manage` | Assign complaints to a technician and link the maintenance visit (head of installations). |
| `quality.grade` | Grade the quality of finished work (head of installations). |
| `checkins.record` | Check in at the company and at visits with the phone's location (technicians, for themselves). |
| `board.view` | Live board of where every technician is today (also for the office screen). |
| `attendance.view` | Monthly attendance and points of every technician. |
| `expenses.record` | Record one's own transport expenses (technicians and the driver). |
| `expenses.pay` | See everyone's transport expenses and pay them out (accountant). |
| `route.view` | The company car's route for a day. |
| `car.checkin` | The car's check-ins: left the company, dropped a team, picked a team up, back (driver). |
| `route.manage` | Change the order of the car's stops (head of installations). |
| `products.view` | Product catalogue (read). |
| `products.manage` | Create and edit products, units, categories and brands. |
| `products.export` | Export the product catalogue (Excel). |
| `warehouses.view` | Warehouses, technicians' vehicles and bins (read). |
| `warehouses.manage` | Create and edit warehouses, vehicles and bins, including the negative-stock policy. |
| `inventory.view` | Stock balances, stock documents and the ledger. Technicians only see their own vehicle. |
| `inventory.receive` | Goods receipts and customer returns. |
| `inventory.issue` | Stock issues and supplier returns. |
| `inventory.transfer` | Transfers between warehouses and bins. |
| `inventory.count` | Physical stocktakes (start, count, submit) and adjustment drafts. |
| `inventory.approve` | Approve stocktakes, post adjustments and opening balances, cancel posted documents. |
| `inventory.reports` | Stock valuation, costs and inventory exports. |
| `suppliers.view` | Supplier master (read). |
| `suppliers.manage` | Create and edit suppliers. |
| `sales.view` | Sales invoices (read). |
| `sales.manage` | Prepare and confirm sales invoices (confirming issues the stock). |
| `sales.void` | Cancel a confirmed sale (reverses its stock issue; needs a reason). |
| `analytics.view` | Sales and product analytics: rankings, trends, turnover, valuation. |
| `attendance.manage` | Review flagged check-ins (outside the geofence, no location), approved work locations, geofences. |
| `evidence.review` | Approve or reject the work evidence technicians submit for a visit. |
| `penalties.view` | See everyone's violations and deductions. |
| `penalties.manage` | Record violations and set the penalty rules. |
| `penalties.approve` | Approve, reject or cancel violations and deductions (only approved deductions reach finance). |
| `penalties.own` | See one's own violations and deductions (employees). |

Role defaults. Generated from `roleDefaults` and `VIEWER_GRANTABLE` with both settings **off**;
"setting" = granted when the related setting is on (the default); "grantable" = an Admin may tick it
for an individual Viewer in the user form. Any non-Admin permission can also be added or removed for
one person in the permission matrix.

| Permission | Admin | Sales | Technician | Accountant | Store keeper | Warehouse manager | Driver | Viewer |
|---|---|---|---|---|---|---|---|---|
| `appointments.view` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | grantable |
| `appointments.manage` | ✓ | ✓ |  |  |  |  |  |  |
| `appointments.create` | ✓ | ✓ |  |  |  |  |  |  |
| `appointments.cancel` | ✓ | ✓ |  |  |  |  |  |  |
| `appointments.assign` | ✓ | ✓ |  |  |  |  |  |  |
| `appointments.export` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| `customers.view` | ✓ | ✓ |  | ✓ |  |  |  | grantable |
| `customers.contact` | ✓ | ✓ | setting | ✓ |  |  | ✓ | grantable |
| `location.view` | ✓ | ✓ | ✓ |  |  |  | ✓ | grantable |
| `notes.internal` | ✓ | ✓ |  |  |  |  |  | grantable |
| `history.view` | ✓ | ✓ |  |  |  |  |  | grantable |
| `visits.report` | ✓ |  | ✓ |  |  |  |  |  |
| `leaves.request` | ✓ |  | ✓ |  |  |  |  |  |
| `leaves.manage` | ✓ |  |  |  |  |  |  |  |
| `finance.view` | ✓ |  |  | ✓ |  |  |  |  |
| `cash.receive` | ✓ |  |  | ✓ |  |  |  |  |
| `finance.export` | ✓ |  |  | ✓ |  |  |  |  |
| `stock.view` | ✓ |  | ✓ | ✓ | ✓ | ✓ |  |  |
| `stock.manage` | ✓ |  |  |  | ✓ | ✓ |  |  |
| `reports.view` | ✓ | setting |  |  |  |  |  | grantable |
| `reports.export` | ✓ | setting |  |  |  |  |  |  |
| `users.manage` | ✓ |  |  |  |  |  |  |  |
| `settings.manage` | ✓ |  |  |  |  |  |  |  |
| `audit.view` | ✓ |  |  |  |  |  |  |  |
| `complaints.view` | ✓ | ✓ | ✓ |  |  |  |  | grantable |
| `complaints.manage` | ✓ |  |  |  |  |  |  |  |
| `quality.grade` | ✓ |  |  |  |  |  |  |  |
| `checkins.record` | ✓ |  | ✓ |  |  |  |  |  |
| `board.view` | ✓ |  |  |  |  |  |  | grantable |
| `attendance.view` | ✓ |  |  | ✓ |  |  |  |  |
| `expenses.record` | ✓ |  | ✓ |  |  |  | ✓ |  |
| `expenses.pay` | ✓ |  |  | ✓ |  |  |  |  |
| `route.view` | ✓ |  |  |  |  |  | ✓ | grantable |
| `car.checkin` | ✓ |  |  |  |  |  | ✓ |  |
| `route.manage` | ✓ |  |  |  |  |  |  |  |
| `products.view` | ✓ | ✓ |  | ✓ | ✓ | ✓ |  | grantable |
| `products.manage` | ✓ |  |  |  |  | ✓ |  |  |
| `products.export` | ✓ | ✓ |  | ✓ | ✓ | ✓ |  |  |
| `warehouses.view` | ✓ |  |  | ✓ | ✓ | ✓ |  | grantable |
| `warehouses.manage` | ✓ |  |  |  |  | ✓ |  |  |
| `inventory.view` | ✓ |  | ✓ | ✓ | ✓ | ✓ |  | grantable |
| `inventory.receive` | ✓ |  |  |  | ✓ | ✓ |  |  |
| `inventory.issue` | ✓ |  |  |  | ✓ | ✓ |  |  |
| `inventory.transfer` | ✓ |  |  |  | ✓ | ✓ |  |  |
| `inventory.count` | ✓ |  |  |  | ✓ | ✓ |  |  |
| `inventory.approve` | ✓ |  |  |  |  | ✓ |  |  |
| `inventory.reports` | ✓ |  |  | ✓ |  | ✓ |  | grantable |
| `suppliers.view` | ✓ |  |  | ✓ | ✓ | ✓ |  | grantable |
| `suppliers.manage` | ✓ |  |  |  |  | ✓ |  |  |
| `sales.view` | ✓ | ✓ |  | ✓ |  | ✓ |  | grantable |
| `sales.manage` | ✓ | ✓ |  |  |  |  |  |  |
| `sales.void` | ✓ |  |  | ✓ |  |  |  |  |
| `analytics.view` | ✓ | setting |  | ✓ |  | ✓ |  | grantable |
| `attendance.manage` | ✓ |  |  |  |  |  |  |  |
| `evidence.review` | ✓ |  |  |  |  |  |  |  |
| `penalties.view` | ✓ |  |  | ✓ |  |  |  |  |
| `penalties.manage` | ✓ |  |  |  |  |  |  |  |
| `penalties.approve` | ✓ |  |  |  |  |  |  |  |
| `penalties.own` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |

Rights that existed before as part of a broader one are given by default with it, so nobody lost
access when they were split out: `appointments.manage` brings `appointments.create`,
`appointments.cancel` and `appointments.assign`; `appointments.view` brings `appointments.export`;
`reports.view` brings `reports.export`; `finance.view` brings `finance.export`; `products.view`
brings `products.export`. In the matrix they are separate boxes and can be removed one by one.

Inactive users have no permissions at all.

### Modules, levels and scopes

What each level includes, per module (generated from `MODULES` and `permissionsForLevel`); a level
includes everything of the levels before it. "Default scope" is the role's default when nothing is
configured (all scopes are *All* for the Admin):

| Module | View only | + create | + edit | Full access adds | Records (scopes) | Default scope |
|---|---|---|---|---|---|---|
| appointments | `appointments.view`, `location.view`, `notes.internal`, `history.view` | `appointments.create` | `appointments.manage`, `appointments.assign` | `appointments.cancel`, `appointments.export` | OWN, ASSIGNED, TEAM, ALL | Sales: ALL; Technician: ASSIGNED; Accountant: ALL; Store: ALL; Warehouse manager: ALL; Driver: ASSIGNED |
| customers | `customers.view`, `customers.contact` | — | — | — | OWN, ASSIGNED, TEAM, ALL | Sales: ALL; Technician: ALL; Accountant: ALL; Store: ALL; Warehouse manager: ALL; Driver: ALL |
| visits | — | `checkins.record` | `visits.report` | — | — | — |
| board | `board.view` | — | — | — | — | — |
| route | `route.view` | `car.checkin` | `route.manage` | — | — | — |
| complaints | `complaints.view` | — | `complaints.manage` | — | OWN, ASSIGNED, TEAM, ALL | Sales: ALL; Technician: ASSIGNED; Accountant: ALL; Store: ALL; Warehouse manager: ALL; Driver: ALL |
| afterSales | — | — | `quality.grade` | — | — | — |
| workReview | — | — | — | `evidence.review` | — | — |
| leaves | — | `leaves.request` | — | `leaves.manage` | OWN, TEAM, ALL | Sales: OWN; Technician: OWN; Accountant: OWN; Store: OWN; Warehouse manager: OWN; Driver: OWN |
| attendance | `attendance.view` | — | — | `attendance.manage` | OWN, TEAM, ALL | Sales: OWN; Technician: OWN; Accountant: ALL; Store: OWN; Warehouse manager: OWN; Driver: OWN |
| expenses | — | `expenses.record` | — | `expenses.pay` | OWN, TEAM, ALL | Sales: OWN; Technician: OWN; Accountant: ALL; Store: OWN; Warehouse manager: OWN; Driver: OWN |
| finance | `finance.view` | — | `cash.receive` | `finance.export` | — | — |
| reports | `reports.view` | — | — | `reports.export` | — | — |
| serialCustody | `stock.view` | — | `stock.manage` | — | — | — |
| products | `products.view` | — | `products.manage` | `products.export` | — | — |
| warehouses | `warehouses.view` | — | `warehouses.manage` | — | — | — |
| inventory | `inventory.view` | `inventory.receive`, `inventory.issue`, `inventory.transfer`, `inventory.count` | — | `inventory.approve`, `inventory.reports` | ASSIGNED, ALL | Sales: ALL; Technician: ASSIGNED; Accountant: ALL; Store: ALL; Warehouse manager: ALL; Driver: ALL |
| suppliers | `suppliers.view` | — | `suppliers.manage` | — | — | — |
| sales | `sales.view` | `sales.manage` | — | `sales.void` | OWN, TEAM, ALL | Sales: ALL; Technician: ALL; Accountant: ALL; Store: ALL; Warehouse manager: ALL; Driver: ALL |
| analytics | `analytics.view` | — | — | — | — | — |
| penalties | `penalties.own`, `penalties.view` | — | `penalties.manage` | `penalties.approve` | OWN, TEAM, ALL | Sales: OWN; Technician: OWN; Accountant: ALL; Store: OWN; Warehouse manager: OWN; Driver: OWN |
| users (Admin only) | — | — | — | `users.manage` | — | — |
| settings (Admin only) | — | — | — | `settings.manage` | — | — |
| audit (Admin only) | `audit.view` | — | — | — | — | — |

## 5. Business rules

- **Server first.** Every service function checks the permission itself (`assertCan`,
  `assertCanAny`, `hasPermission` in `src/server/access.ts`), so a new route cannot forget it;
  pages check again with `requirePagePermission`.
- **Data scopes are applied in the database query**, so an id outside the reader's scope returns
  404 and reveals nothing (changing an id in the address or in an API call does not help):

  | Scope | Bookings (`appointmentScope`) | Customers | Complaints | Sales invoices | People-based modules (leaves, attendance, expenses, penalties) |
  |---|---|---|---|---|---|
  | All | everything | everything | everything | everything | everyone |
  | Team | own + assigned + made by or assigned to a team member | customers of those bookings and of the team's sales | created by or assigned to the person or a team member | created by the person or a member | the person and their team members |
  | Assigned | assigned to the person (the driver: visits that need the car) | customers of their assigned visits | assigned to them and not closed | — | — |
  | Own | created by the person | customers of their bookings and sales | created by them | created by them | the person only |

  Inventory offers *Assigned* (the technician's own vehicle) or *All*. A person without a team who
  has *Team* sees what *Own* and *Assigned* would show together (people-based modules: only
  themselves).
- **No self-escalation.** Only an Admin (role `ADMIN` **and** `users.manage`) can change
  permissions, scopes or teams; nobody can change their own; an Admin's access cannot be changed
  (it is always everything); Admin-only permissions cannot be given to anyone else, and are removed
  again on every request even if written straight into the database.
- **Separate rights for separate actions.** Booking (`appointments.create`), assigning technicians
  (`appointments.assign`), editing (`appointments.manage`), cancelling (`appointments.cancel`) and
  exporting (`appointments.export`, `reports.export`, `finance.export`, `products.export`,
  `inventory.reports`) are checked separately. Someone who may edit but not assign keeps the
  technicians as they are.
- Costs (purchase cost, average cost, stock value, margins) are sent only to people with
  `inventory.reports`, `products.manage` or `inventory.approve`.
- Money decisions are separated: penalties are proposed by rules or managers and approved with
  `penalties.approve`, and nobody decides on their own violation; sales are confirmed with
  `sales.manage` and voided only with `sales.void`; stock adjustments are drafted with
  `inventory.count` and posted with `inventory.approve`; leave and expenses are decided only for
  people inside the manager's scope.
- The last active Admin cannot be demoted or deactivated.
- A role, creator, permission or scope sent by the browser is ignored (the server reads them from
  the session and the database).
- Every change of permissions, scopes, team, role or activation is written to the audit log with
  who, what changed (permissions added and removed, scopes before and after) and the reason.

## 6. Database models and relationships

- `users.role` (enum `Role`), `users.isActive`, `users.viewerPermissions` (text array, checked
  against the grantable list).
- `users.permissionGrants`, `users.permissionDenies` (text arrays, default empty): the individual
  difference from the role. Only the difference is stored, so a later change of role defaults still
  reaches everybody who has not been changed.
- `users.dataScopes` (JSON, nullable): `{ module: "OWN" | "ASSIGNED" | "TEAM" | "ALL" }`, only the
  modules that differ from the role's default; unknown modules or scopes a module does not offer
  are ignored.
- `users.teamId` → `teams` (`id`, `name`, `nameAr`, `isActive`); deleting a team is refused by a
  database trigger (teams are deactivated), and a team that disappeared anyway leaves its members
  without a team (`ON DELETE SET NULL`).
- Settings `salesCanViewReports` and `technicianCanSeeContacts`; `sessions` resolve to the user
  (and their effective permissions and scopes) in one query on each request.
- Migration: `prisma/migrations/20261110090000_permissions_teams_audit_context` (additive only; its
  rollback is described in the file).

## 7. API routes

Every route under `src/app/api` is wrapped by `apiRoute` (`src/server/http.ts`): same-origin check
for state-changing requests (403), session check (401), then the service's permission and scope
checks (403 / 404), with JSON errors in the reader's language. `publicRoute` is used only for
sign-in, sign-out and set-password.

| Route | Method | Who | Purpose |
|---|---|---|---|
| `/api/users/[id]/access` | GET | Admin | Role defaults, grants, denies, effective permissions, scopes, default scopes, team, what may be assigned, templates, people to copy from |
| `/api/users/[id]/access` | PUT | Admin (not on themselves, not on an Admin) | `{ mode: "set", permissions, scopes, teamId, reason }`, `{ mode: "reset" }`, `{ mode: "copy", fromUserId }`, `{ mode: "template", template }` (all take `reason`); answers `{ changed: false }` when nothing changed |
| `/api/teams` | GET, POST | Admin | List and create teams |
| `/api/teams/[id]` | PATCH | Admin | Rename or deactivate a team |

## 8. Services and important logic

- `src/lib/permissions.ts`: `PERMISSIONS`, `roleDefaults`, `permissionsFor` (role + grants −
  denies, Admin-only and Viewer limits), `overridesFor` (the difference to store), `VIEWER_GRANTABLE`,
  `canSeeCosts`.
- `src/lib/permission-registry.ts`: `MODULES`, `ACTION_KINDS`, `LEVELS`, `permissionsForLevel`,
  `levelOf`, `defaultScope`, `scopesFor`, `scopeOverrides`, `ADMIN_ONLY_PERMISSIONS`, `viewerMayHold`.
- `src/lib/permission-templates.ts`: `TEMPLATE_IDS`, `templateFor`.
- `src/server/access.ts`: `assertCan`, `assertCanAny`, `hasPermission`, `scopeOf`, and the scope
  filters `appointmentScope` / `appointmentScopeSql`, `customerScope` / `customerScopeSql`,
  `complaintScopeWhere`, `salesScope`, `peopleScope` / `peopleScopeSql` / `inPeopleScope`,
  `vehicleScoped`.
- `src/server/services/access-control.ts`: `getUserAccess`, `setUserAccess` (validation, the
  escalation rules, row lock, one transaction with the audit entry), `listTeams`, `saveTeam`.
- `src/server/auth/session.ts`: `requireUser`, `requirePagePermission`; `CurrentUser` carries
  `permissions`, `scopes` and `teamId`.
- Interface: `src/components/users/permission-editor.tsx`, `src/components/users/teams-manager.tsx`,
  the navigation in `src/components/layout/app-shell.tsx` (shows only what the user may open).

## 9. Validation rules

Role must be one of the eight; Viewer permissions must be in the grantable list (others are
dropped); the last active Admin keeps the Admin role. The access body is validated with zod: known
modes only, at most 200 permission keys of at most 60 characters, scopes from the four values,
reason up to 500 characters. Unknown permission keys are ignored; Admin-only or (for Viewers)
non-read permissions are refused with the list of what cannot be given (a template or copy simply
leaves them out); the team must exist and be
active; one cannot copy a person onto themselves.

## 10. Error handling

401 with a clean JSON error (the browser goes to the sign-in page); 403 with the reason (also for
changing one's own permissions); 404 for records outside the reader's scope and unknown people;
422 with the field errors for invalid access changes; pages redirect to `/access-denied`.

## 11. Tests

- `tests/unit/permission-registry.test.ts`: every permission in exactly one module, Admin-only list,
  levels, default scopes reproduce the old fixed scopes, configured scopes, grants and denies,
  Admin-only and Viewer limits, the stored difference, templates.
- `tests/unit/lib.test.ts`: the permission table per role.
- `tests/integration/access-control.test.ts`: escalation guards, stored difference and audit entry
  with reason, copy / template / reset / role change, view-only users refused create / edit /
  cancel, assign and cancel as separate rights, *Own* and *Team* scopes for bookings, customers,
  leaves and expenses, audit immutability and corrections.
- `tests/integration/access-api.test.ts`: the same through the real route handlers: 401 without a
  session, 403 for every non-Admin (on others and on themselves), Admin-only rights written into the
  database still refused, an Admin cannot change themselves or another Admin, changes apply on the
  next request, changed ids under *Own* scope answer 404, *Team* scope follows the team and stops
  when the team is deactivated, exports need their own right and are logged.
- `tests/integration/permissions.test.ts`, `tests/integration/api.test.ts`,
  `tests/integration/erp-api.test.ts`, `tests/integration/inventory-api.test.ts` and the service
  tests of each module (each checks its rights).
- `e2e/access.spec.ts`: an Admin narrows a Sales employee to viewing their own bookings in the
  matrix, the employee's session and hand-made API calls are refused, the audit log shows the
  change with its reason and request; the Admin's own matrix is locked; the screen in Arabic (right
  to left) and at phone width. `e2e/permissions.spec.ts`, `e2e/penalties.spec.ts`.

## 12. Current limitations

- No custom roles: individual changes are per person (templates and *Copy from* cover the common
  cases).
- No per-warehouse permissions; inventory scope is the technician's own vehicle or everything.
- Serial-number custody (`stock.view`) keeps its built-in rule (technicians see what they hold)
  and has no scope column.
- The legacy Viewer check boxes in the user form remain alongside the matrix.
- A person belongs to at most one team.

## 13. Future improvements

Custom roles built from the registry; warehouse-scoped managers; several teams per person; a
report of effective permissions for all users at once.
