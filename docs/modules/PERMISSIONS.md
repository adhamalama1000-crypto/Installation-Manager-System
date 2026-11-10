# Permissions

## 1. Module purpose

Decide, for every role and every action, what a person may see and do, and enforce it **on the
server** for every page, API route and service function; the interface only hides what the server
would refuse anyway.

## 2. How users operate it

Admins set each user's role in *Users*. Viewer accounts get individual read-only permissions
(check boxes) from the grantable list. Two settings change role permissions: *Sales can view
reports* (adds `reports.view` and `analytics.view` to Sales) and *Technicians can see customer phone
numbers* (adds `customers.contact` to technicians); **both are on by default**. A page someone may
not open redirects to *Access denied*; an API call returns 401 (not signed in), 403 (no right) or
404 (a record outside their scope).

## 3. Available features

One pure permission table shared by the server and the interface (`src/lib/permissions.ts`); eight
roles; Viewer grants; record scopes on top of permissions (technicians: their assignments and their
own vehicle; drivers: the car's visits; Sales: other people's bookings only when the setting allows;
employees: their own attendance photos and their own decided violations); cost visibility rules.

## 4. Roles and permissions

What each permission allows (from the comments in `src/lib/permissions.ts`):

| Permission | Allows |
|---|---|
| `appointments.view` | See appointments. Technicians are additionally restricted to their own assignments. |
| `appointments.manage` | Create, edit, reschedule, assign technicians, change status, cancel. |
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
| `stock.view` | Stock by serial number. Technicians only see the items they hold. |
| `stock.manage` | Register goods in, hand items to technicians, take them back, mark returned / faulty; models and warranty. |
| `reports.view` | Reports pages and the appointments CSV export. |
| `users.manage` | Users: create, edit roles and permissions, deactivate, password links. |
| `settings.manage` | Settings: company location, working hours, geofences, delivery rules, statuses, colours, evidence rules. |
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

Who has it. Generated from `permissionsFor` and `VIEWER_GRANTABLE` with both settings **off**;
"setting" = granted when the related setting is on (the default); "grantable" = an Admin may grant
it to an individual Viewer:

| Permission | Admin | Sales | Technician | Accountant | Store keeper | Warehouse manager | Driver | Viewer |
|---|---|---|---|---|---|---|---|---|
| `appointments.view` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | grantable |
| `appointments.manage` | ✓ | ✓ |  |  |  |  |  |  |
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
| `stock.view` | ✓ |  | ✓ | ✓ | ✓ | ✓ |  |  |
| `stock.manage` | ✓ |  |  |  | ✓ | ✓ |  |  |
| `reports.view` | ✓ | setting |  |  |  |  |  | grantable |
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

Inactive users have no permissions at all.

## 5. Business rules

- Every service function checks the permission itself (`assertCan` / `hasPermission` in
  `src/server/access.ts`), so a new route cannot forget it; pages check again with
  `requirePagePermission`.
- Scope is applied in the database query (`appointmentScope`, warehouse scope, own records), so
  out-of-scope ids return 404 and reveal nothing.
- Costs (purchase cost, average cost, stock value, margins) are sent only to people with
  `inventory.reports`, `products.manage` or `inventory.approve`.
- Money decisions are separated: penalties are proposed by rules or managers and approved with
  `penalties.approve`, and nobody decides on their own violation; sales are confirmed with
  `sales.manage` and voided only with `sales.void`; stock adjustments are drafted with
  `inventory.count` and posted with `inventory.approve`.
- The last active Admin cannot be demoted or deactivated.
- A role, creator or permission sent by the browser is ignored (the server reads them from the
  session and the database).

## 6. Database models and relationships

`users.role` (enum `Role`), `users.viewerPermissions` (text array, checked against the grantable
list), `users.isActive`, settings `salesCanViewReports` and `technicianCanSeeContacts`; `sessions`
resolve to the user on each request.

## 7. API routes

Every route under `src/app/api` is wrapped by `apiRoute` (`src/server/http.ts`): same-origin check
for state-changing requests (403), session check (401), then the service's permission check (403 /
404), with JSON errors in the reader's language. `publicRoute` is used only for sign-in and
set-password.

## 8. Services and important logic

`src/lib/permissions.ts` (`PERMISSIONS`, `permissionsFor`, `VIEWER_GRANTABLE`, `isAssignmentScoped`,
`isVehicleScoped`, `canSeeCosts`), `src/server/access.ts` (`assertCan`, `hasPermission`,
`appointmentScope`), `src/server/auth/session.ts` (`requireUser`, `requirePagePermission`), the
navigation in `src/components/layout/app-shell.tsx` (shows only what the user may open).

## 9. Validation rules

Role must be one of the eight; Viewer permissions must be in the grantable list (others are
dropped); the last active Admin keeps the Admin role.

## 10. Error handling

401 with a clean JSON error (the browser goes to the sign-in page); 403 with the reason; 404 for
records outside the reader's scope; pages redirect to `/access-denied`.

## 11. Tests

`tests/unit/lib.test.ts` (the permission table per role, including every new permission),
`tests/integration/permissions.test.ts`, `tests/integration/api.test.ts` (401 / 403 / scope through
the real route handlers), `tests/integration/erp-api.test.ts` (evidence and penalty routes per
role), `tests/integration/inventory-api.test.ts`, the service tests of each module (each checks its
rights), `e2e/permissions.spec.ts` (sign-in, technicians read-only and scoped, viewers cannot
modify), `e2e/penalties.spec.ts` (an employee is denied the violations list).

## 12. Current limitations

Permissions are per role (plus Viewer grants); there are no per-warehouse or per-team permissions
and no custom roles. Work review and penalty approval are Admin-only by default.

## 13. Future improvements

Custom roles built from the permission list; warehouse- and team-scoped managers; a permission
report per user in the Users page.
