# Role and permission matrix

How access is decided, the default role templates, and the full permission table. The tables are
generated from `src/lib/permissions.ts` and `src/lib/permission-registry.ts` (the same code the
server enforces), with the default settings (*Sales can view reports* and *Technicians can see
customer phone numbers* both on).

## 1. How a person's access is computed

On **every request**, from the database (`src/server/auth/session.ts`, one query):

1. **Base role** (Admin, Sales, Technician, Accountant, Store keeper, Warehouse manager,
   Installation manager, Driver, Viewer). The base role also decides record scoping (technicians see
   their assigned visits, drivers the car's visits, technicians only their own vehicle's stock).
2. **Custom role**, if the person has one: an Admin-defined set of permissions and record scopes
   for people of that base role (*Users → Roles and permissions*). It **replaces** the base role's
   default permissions. Editing a custom role changes everyone who has it on their next click.
3. **Individual changes** on the person's permission screen (*Users → Permissions*): permissions
   added or removed on top of 1–2, and record scopes per module.
4. **Hard limits no stored value can lift:** Admins always have every permission and all records;
   `users.manage`, `settings.manage` and `audit.view` are Admin-only; a Viewer (and a
   Viewer-based custom role) only ever holds view and export permissions; a deactivated person has
   none.

Nobody can change their own permissions or role (another Admin must). Every change, to a person or
to a custom role, is audited with the permissions added and removed and the reason; *Roles and
permissions → Permission change history* opens the audit log filtered to these changes.

**Server-side enforcement.** Every page calls `requirePagePermission` (refused pages redirect to
*Access denied*), every API route goes through `apiRoute` (401 without a session, 403 without the
permission), and every service function calls `assertCan` and applies the record scope in its
database query (a record outside the reader's scope answers 404, so ids cannot be probed). Hiding a
button is never the protection.

## 2. Default role templates

| Spec role | Implemented as | Notes |
|---|---|---|
| **A. Administrator** | Built-in **Admin** | Everything, always. Manages users, roles, permissions, settings, audit log. |
| **B. Installation Manager** | Built-in **Installation manager** (new) | Every booking: create, edit, reschedule, cancel, assign, book for a Sales employee and edit anyone's bookings (`appointments.manageAll`); every technician's schedule; leave, complaints, quality, work review, live board, attendance review, car route; reports. No money, stock movements, users or settings. |
| **C. Technician** | Built-in **Technician** | Own assigned visits only (record scope *Assigned*); record outcomes, check in, photos and evidence, leave requests, own vehicle stock, own expenses. Cannot reassign or change schedules. |
| **D. Warehouse Employee** | Built-in **Store keeper**, or a **custom role** based on it | The store keeper receives, issues, transfers and counts stock but does not create products or approve adjustments. A warehouse employee who also creates products is a custom role based on *Store keeper* with *Products → create/edit* added (create it from *Roles and permissions → Store keeper → Custom role from this*). See *Decisions* below. |
| **E. Sales Representative** | Built-in **Sales** | Books and follows bookings, customers, sales invoices. Record scope *All* by default; the template *Sales: own customers and records only* (or a custom role) limits it to their own. Cannot change technician assignments of other people's bookings unless *Sales can edit each other's bookings* is on. |
| (also) | Accountant, Warehouse manager, Driver, Viewer | Unchanged. |

Every template is a starting point: an Admin can create a custom role from any built-in role and
change it, or change one person's permissions, without code changes.

## 3. Permissions by role (defaults)

| Module | Permission | Admin | Sales | Tech | Acct | Store | WH mgr | Inst mgr | Driver | Viewer |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| appointments | `appointments.view` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| appointments | `location.view` | ✓ | ✓ | ✓ |  |  |  | ✓ | ✓ |  |
| appointments | `notes.internal` | ✓ | ✓ |  |  |  |  | ✓ |  |  |
| appointments | `history.view` | ✓ | ✓ |  |  |  |  | ✓ |  |  |
| appointments | `appointments.create` | ✓ | ✓ |  |  |  |  | ✓ |  |  |
| appointments | `appointments.manage` | ✓ | ✓ |  |  |  |  | ✓ |  |  |
| appointments | `appointments.assign` | ✓ | ✓ |  |  |  |  | ✓ |  |  |
| appointments | `appointments.cancel` | ✓ | ✓ |  |  |  |  | ✓ |  |  |
| appointments | `appointments.export` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| scheduling | `appointments.manageAll` | ✓ |  |  |  |  |  | ✓ |  |  |
| customers | `customers.view` | ✓ | ✓ |  | ✓ |  |  | ✓ |  |  |
| customers | `customers.contact` | ✓ | ✓ | ✓ | ✓ |  |  | ✓ | ✓ |  |
| visits | `checkins.record` | ✓ |  | ✓ |  |  |  |  |  |  |
| visits | `visits.report` | ✓ |  | ✓ |  |  |  | ✓ |  |  |
| board | `board.view` | ✓ |  |  |  |  |  | ✓ |  |  |
| route | `route.view` | ✓ |  |  |  |  |  | ✓ | ✓ |  |
| route | `car.checkin` | ✓ |  |  |  |  |  |  | ✓ |  |
| route | `route.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| complaints | `complaints.view` | ✓ | ✓ | ✓ |  |  |  | ✓ |  |  |
| complaints | `complaints.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| afterSales | `quality.grade` | ✓ |  |  |  |  |  | ✓ |  |  |
| workReview | `evidence.review` | ✓ |  |  |  |  |  | ✓ |  |  |
| leaves | `leaves.request` | ✓ |  | ✓ |  |  |  |  |  |  |
| leaves | `leaves.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| attendance | `attendance.view` | ✓ |  |  | ✓ |  |  | ✓ |  |  |
| attendance | `attendance.manage` | ✓ |  |  |  |  |  | ✓ |  |  |
| expenses | `expenses.record` | ✓ |  | ✓ |  |  |  |  | ✓ |  |
| expenses | `expenses.pay` | ✓ |  |  | ✓ |  |  |  |  |  |
| finance | `finance.view` | ✓ |  |  | ✓ |  |  |  |  |  |
| finance | `cash.receive` | ✓ |  |  | ✓ |  |  |  |  |  |
| finance | `finance.export` | ✓ |  |  | ✓ |  |  |  |  |  |
| reports | `reports.view` | ✓ | ✓ |  |  |  |  | ✓ |  |  |
| reports | `reports.export` | ✓ | ✓ |  |  |  |  | ✓ |  |  |
| serialCustody | `stock.view` | ✓ |  | ✓ | ✓ | ✓ | ✓ | ✓ |  |  |
| serialCustody | `stock.manage` | ✓ |  |  |  | ✓ | ✓ |  |  |  |
| products | `products.view` | ✓ | ✓ |  | ✓ | ✓ | ✓ | ✓ |  |  |
| products | `products.manage` | ✓ |  |  |  |  | ✓ |  |  |  |
| products | `products.export` | ✓ | ✓ |  | ✓ | ✓ | ✓ | ✓ |  |  |
| products | `products.lock` | ✓ |  |  |  |  | ✓ |  |  |  |
| products | `products.unlock` | ✓ |  |  |  |  | ✓ |  |  |  |
| products | `products.archive` | ✓ |  |  |  |  | ✓ |  |  |  |
| warehouses | `warehouses.view` | ✓ |  |  | ✓ | ✓ | ✓ | ✓ |  |  |
| warehouses | `warehouses.manage` | ✓ |  |  |  |  | ✓ |  |  |  |
| inventory | `inventory.view` | ✓ |  | ✓ | ✓ | ✓ | ✓ | ✓ |  |  |
| inventory | `inventory.receive` | ✓ |  |  |  | ✓ | ✓ |  |  |  |
| inventory | `inventory.issue` | ✓ |  |  |  | ✓ | ✓ |  |  |  |
| inventory | `inventory.transfer` | ✓ |  |  |  | ✓ | ✓ |  |  |  |
| inventory | `inventory.count` | ✓ |  |  |  | ✓ | ✓ |  |  |  |
| inventory | `inventory.approve` | ✓ |  |  |  |  | ✓ |  |  |  |
| inventory | `inventory.reports` | ✓ |  |  | ✓ |  | ✓ |  |  |  |
| inventory | `stocktakes.schedule` | ✓ |  |  |  |  | ✓ |  |  |  |
| suppliers | `suppliers.view` | ✓ |  |  | ✓ | ✓ | ✓ |  |  |  |
| suppliers | `suppliers.manage` | ✓ |  |  |  |  | ✓ |  |  |  |
| sales | `sales.view` | ✓ | ✓ |  | ✓ |  | ✓ |  |  |  |
| sales | `sales.manage` | ✓ | ✓ |  |  |  |  |  |  |  |
| sales | `sales.void` | ✓ |  |  | ✓ |  |  |  |  |  |
| analytics | `analytics.view` | ✓ | ✓ |  | ✓ |  | ✓ |  |  |  |
| penalties | `penalties.own` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| penalties | `penalties.view` | ✓ |  |  | ✓ |  |  |  |  |  |
| penalties | `penalties.manage` | ✓ |  |  |  |  |  |  |  |  |
| penalties | `penalties.approve` | ✓ |  |  |  |  |  |  |  |  |
| users (Admin only) | `users.manage` | ✓ |  |  |  |  |  |  |  |  |
| settings (Admin only) | `settings.manage` | ✓ |  |  |  |  |  |  |  |  |
| audit (Admin only) | `audit.view` | ✓ |  |  |  |  |  |  |  |  |

## 4. Default record scopes

*OWN* = records they created or that belong to them; *ASSIGNED* = records they are assigned to;
*TEAM* = their team's; *ALL* = everything. Configurable per person and per custom role.

| Module | Admin | Sales | Tech | Acct | Store | WH mgr | Inst mgr | Driver | Viewer |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| appointments | ALL | ALL | ASSIGNED | ALL | ALL | ALL | ALL | ASSIGNED | ALL |
| customers | ALL | ALL | ALL | ALL | ALL | ALL | ALL | ALL | ALL |
| complaints | ALL | ALL | ASSIGNED | ALL | ALL | ALL | ALL | ALL | ALL |
| leaves | ALL | OWN | OWN | OWN | OWN | OWN | ALL | OWN | OWN |
| attendance | ALL | OWN | OWN | ALL | OWN | OWN | ALL | OWN | OWN |
| expenses | ALL | OWN | OWN | ALL | OWN | OWN | OWN | OWN | OWN |
| inventory | ALL | ALL | ASSIGNED | ALL | ALL | ALL | ALL | ALL | ALL |
| sales | ALL | ALL | ALL | ALL | ALL | ALL | ALL | ALL | ALL |
| penalties | ALL | OWN | OWN | ALL | OWN | OWN | OWN | OWN | OWN |

## 5. Decisions taken, and questions for the owner

1. **Warehouse employee.** Implemented as the existing *Store keeper* role (plus a custom role when
   they should also create products), rather than a second built-in role with almost the same
   rights. Existing store keepers keep exactly their access. *Question:* should store keepers create
   and edit products by default?
2. **Booking on behalf of Sales and editing anyone's bookings** used to be hard-coded to the Admin
   role; it is now the permission `appointments.manageAll` (Admin and Installation manager by
   default, grantable to anyone).
3. **Custom roles are tied to one base role**, because the base role decides record scoping. A
   custom role cannot be deactivated while people have it, so deactivating a role can never change
   anyone's access silently. Roles are never deleted.
4. **Giving or removing a custom role clears the person's individual changes**, as a change of role
   already did.
