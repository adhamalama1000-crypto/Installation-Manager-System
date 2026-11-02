# Implementation status

This page is updated after each completed phase. The feature-by-feature comparison with Aura is in [FEATURE_MIGRATION_MATRIX.md](FEATURE_MIGRATION_MATRIX.md).

Phases A to E (#5 to #10), #11, #12 and ERP phase 1, the inventory foundation (#14), are merged into `main`. #4, the earlier parallel Arabic/English branch, was closed as superseded on 2026-11-01. Its useful parts landed in #11 and #12, and the closing comment on #4 says where each of its changes now lives. Its branch is kept.

A phase is marked **done** only when its code is committed, and lint, typecheck, unit and integration tests, the production build and the browser tests all passed on that commit. A phase is **merged** only after the owner approves and merges its pull request.

## Delivered

| Work | Pull request | State |
|---|---|---|
| Performance fixes, Aura phases 1–6 (booking details, visit outcome, leave, payments, inventory, day plan) | #1 | Merged |
| Dashboard counters in one statement, auto-refresh paused while typing | #2 | Merged |
| Arabic-first interface (RTL) with an Arabic/English switch | #3 | Merged |
| Aura phases A to E (see below) | #5, #6 → #10, #7, #8, #9 | Merged |
| Useful parts of #4: in-place language switch, prepare-the-site texts, text lint rule, system audit | #11 | Merged |
| Booking follow-ups: automatic holds under the per-technician lock, dashboard readiness warning, lock pickup in the day plan | #12 | Merged |
| Parallel Arabic/English branch, superseded by #3, #11 and #12 | #4 | Closed |
| ERP phase 1: inventory foundation (catalogue, warehouses and vans, stock ledger, stock documents, stocktakes, Warehouse manager role); see [INVENTORY.md](INVENTORY.md) | #14 | Merged |

## Remaining Aura features

| Phase | Scope | Branch | State |
|---|---|---|---|
| A: Delivery proof | Photos, signature, payment and deposit proofs, delivery checklist, serial-required setting | `claude/aura-delivery-proof` | Merged (#5) |
| B: After-sales | Complaints, ratings, quality grade, satisfaction and quality lists, maintenance reminders | `claude/aura-after-sales` | Merged (#6, landed on `main` by #10) |
| C: Field tracking | GPS check-ins, live board, attendance, points, late alerts, automatic repeat-visit fee | `claude/aura-field-tracking` | Merged (#7) |
| D: Expenses and car | Transport expenses, Driver role, car route, car check-ins | `claude/aura-expenses-car` | Merged (#8) |
| E: Booking helpers | Slot holds, quotation parsing, specialty suggestion, booking rules, site readiness | `claude/aura-booking-helpers` | Merged (#9; follow-ups in #12) |

## Check results by phase

### Phase A: delivery proof (2026-10-31)

| Check | Result |
|---|---|
| `npm run lint` | No errors |
| `npm run typecheck` | No errors |
| `npm test` (unit and integration) | 17 files, **140 / 140 passed** (11 new: 10 service tests, 1 API test) |
| `npm run build` | Succeeded |
| `npm run test:e2e` | **20 / 20 passed** on a freshly migrated and seeded database; the new delivery test also passed three repeated runs |
| Overflow sweep | **0 problems**: 17 admin pages and 6 technician pages, including a visit with photos, at 320–1024 px in Arabic and English |
| Migration on the development database | `20261028090000_attachments` applied with `migrate deploy`; appointment, customer, user and audit row counts unchanged |

Found and fixed while testing:
- Quick taps on the checklist could lose a tick, because a page refresh started before a save could arrive after it. Saves now run one at a time, and the checklist keeps the ticks of the page.
- Dialogs had no accessible name. All dialogs are now named by their title.

### Phase B: after-sales (2026-10-31)

| Check | Result |
|---|---|
| `npm run lint` | No errors |
| `npm run typecheck` | No errors |
| `npm test` (unit and integration) | 18 files, **148 / 148 passed** (8 new: 7 service tests, 1 API test; the role test was updated for the new complaint permissions) |
| `npm run build` | Succeeded |
| `npm run test:e2e` | **22 / 22 passed** on a freshly migrated and seeded database; the two new tests also passed two repeated runs |
| Overflow sweep | **0 problems** on the complaints list and detail, the three after-sales lists, the dashboard and a visit with a complaint, for an Admin and a technician, at 320–1024 px in Arabic and English |
| Migration on the development database | `20261029090000_after_sales` applied with `migrate deploy`; row counts unchanged; schema and migrations match (`migrate diff`: no difference) |

Found and fixed while testing:
- English text typed on an Arabic page showed its punctuation on the wrong side. Complaint texts, resolutions and customer notes now take their own direction (`dir="auto"`).
- The after-sales dashboard counts are extra columns of the existing counter statement, so the dashboard does not need more database connections than before.

### Phase C: field tracking (2026-11-01)

| Check | Result |
|---|---|
| `npm run lint` | No errors |
| `npm run typecheck` | No errors |
| `npm test` (unit and integration) | 20 files, **158 / 158 passed** (10 new: 4 unit tests of the distance, arrival-time and points rules, 6 service tests including the late-alert endpoint; the role test was updated for the new permissions) |
| `npm run build` | Succeeded |
| `npm run test:e2e` | **23 / 23 passed** on a freshly migrated and seeded database (the new test uses a simulated phone location) |
| Overflow sweep | **0 problems** on the live board, attendance, settings, the dashboard and a visit with check-ins, for an Admin and a technician, at 320–1024 px in Arabic and English |
| Migration on the development database | `20261030090000_field_tracking` applied with `migrate deploy`; row counts unchanged; `migrate diff`: no difference |

Found and fixed while testing:
- Admins hold every permission, including the technician's check-in permission, so the field log was hidden from them and the dashboard would have shown them "My day". The log is now hidden only from the technician assigned to the visit, and "My day" is shown to technicians only.

Not done in this phase:
- Sending e-mail (Aura's morning e-mail and e-mailed late alerts): no e-mail provider is configured. Late alerts are in-app; the morning summary is the day plan and the dashboard.
- The estimated arrival needs the visit's coordinates; Aura's fallback to the area's centre comes with phase E's areas list.

### Phase D: expenses and the company car (2026-11-01)

| Check | Result |
|---|---|
| `npm run lint` | No errors |
| `npm run typecheck` | No errors |
| `npm test` (unit and integration) | 21 files, **164 / 164 passed** (6 new service tests; the role test was updated for the Driver and expense permissions) |
| `npm run build` | Succeeded |
| `npm run test:e2e` | **25 / 25 passed** on a freshly migrated and seeded database (the seed now has a demo driver) |
| Overflow sweep | **0 problems** on the route, expenses, board, booking form and users pages for an Admin, the driver, the Accountant and a technician, at 320–1024 px in Arabic and English |
| Migrations on the development database | `20261031090000_role_driver` and `20261031090100_expenses_car` applied with `migrate deploy`; row counts unchanged; `migrate diff`: no difference |

Not done in this phase:
- Expenses are not yet in the finance CSV export; they have their own page per month.
- Drivers are not notified of every status change of a car visit (Aura did); they see changes on the route page, which refreshes itself.

### Phase E: booking helpers (2026-11-01)

| Check | Result |
|---|---|
| `npm run lint` | No errors |
| `npm run typecheck` | No errors |
| `npm test` (unit and integration) | 23 files, **175 / 175 passed** (11 new: 4 unit tests of the quotation parser and area matching, 7 service tests including a local stand-in for the quotation site; two older test files now book past visits as the Admin, as the new rule requires) |
| `npm run build` | Succeeded |
| `npm run test:e2e` | **27 / 27 passed** on a freshly migrated and seeded database (one older test now books its past visit as the Admin) |
| Overflow sweep | **0 problems** on the booking form (new and edit), a visit, reports, users and settings at 320–1024 px in Arabic and English |
| Migration on the development database | `20261101090000_booking_helpers` applied with `migrate deploy`; row counts unchanged; `migrate diff`: no difference |

Not done in this phase:
- The quotation reader was tested against saved pages and a local stand-in server, not against the live aura.eg site: this environment's network proxy refuses connections to it (HTTP 403). Set `QUOTE_HOSTS` if the quotation pages live on another host.
- Area, door and device lists are not editable.
- The smart-home readiness reminder was not on the dashboard. It is now: see the booking follow-ups below.

### Booking follow-ups (2026-11-01)

These are the three items #11 left for #9's branch, built on `main` after #9 was merged.

- **Automatic holds.** Picking technicians in the booking form holds them, as Aura did.
  - The hold is renewed every 8 minutes while the form is open.
  - It is replaced when the slot or the choice changes, and released when everyone is unticked, when the booking is saved (new or edited), or when the form is left.
  - An edit page that is only being looked at holds nothing.
  - The manual "Hold 10 minutes" button is gone; the form shows the hold's state instead.
- **Same lock for holds and bookings.**
  - **Found:** holds used one global advisory lock, while bookings lock each technician, so the two never waited for each other. A new test, in which one person holds and another books the same technician at the same moment, saw both succeed in 3 runs out of 3 on `main`.
  - **Fixed:** holds now take the same per-technician lock (`lockTechnicians`), in the same sorted order, so there is no deadlock. The test passes in 3 runs out of 3, over 36 contested rounds.
  - Holds also refuse anyone who is not an active technician; before, an unknown ID failed with a database error.
  - Expired holds are removed whenever holds are released or replaced.
- **Dashboard readiness warning.** The dashboard now warns about the coming week's smart-home installations whose wiring or internet is not confirmed ready (Aura `alerts_`):
  - a banner, and a "Needs attention" reason, in Arabic and English
  - only for the visits each reader may see
  - inspections are left out
  - the check shares the existing "no map location" statement, so the dashboard runs no extra query
- **Lock pickup.** When the lock is kept at the company:
  - the technician's WhatsApp day plan says "🏢 Pick up the lock from the company before you set off" / "🏢 خد اللوك من الشركة قبل ما تتحرك" under that visit
  - the day plan page shows a badge, and the visit shows a notice until it is done
  - the appointment CSV exports have a "Where the lock is" column

No migration: nothing in the database changes.

| Check | Result |
|---|---|
| `npm run lint` | No errors |
| `npm run typecheck` | No errors |
| `npm test` (unit and integration) | 25 files, **187 / 187 passed**. 11 new: 5 hold concurrency and lifecycle tests, 5 dashboard, day plan and export tests, and 1 unit test of the WhatsApp text. |
| `npm run build` | Succeeded |
| `npm run test:e2e` | **29 / 29 passed** on a freshly migrated and seeded database. New: automatic hold, release on untick and on leaving the form. The older conflict test now has the colleague book before the technician is picked. |
| Pages checked | The dashboard, the day plan and the booking form in Arabic and English, at 390 and 1280 px: correct direction, **0 px** horizontal overflow |

Notes:
- `e2e/field.spec.ts` assumes no field check-ins earlier the same day. Run twice against the same database on the same day, its board check sees the earlier run's visit as current. It passes on a fresh database, as in CI.

### `main` after every merge (2026-11-01)

All checks on `5243d5f`, the merge of #12:
- CI passed.
- Run locally:

| Check | Result |
|---|---|
| `npm run lint` | No errors |
| `npm run typecheck` | No errors |
| `npm test` | 25 files, **187 / 187 passed** |
| `npm run build` | Succeeded |
| `npm run test:e2e` | **29 / 29 passed**, on a database freshly migrated and seeded as in CI |
| `prisma migrate status` on the development database | 17 migrations, schema up to date (no reset, no reseed) |

### ERP phase 1: inventory foundation (2026-11-01)

Branch `claude/erp-inventory-foundation`, from `main` after #12; merged as #14 on 2026-11-02. Details, rules and workflows in
[INVENTORY.md](INVENTORY.md).

- **Migrations (additive):** `20261101120000_role_warehouse_manager` (one enum value) and `20261101120100_inventory_foundation` (7 enum types, 14 tables, constraints, 7 triggers, 5 unit rows). Every `ALTER TABLE` in them targets a new table; no existing table, column or row changes.
- **Database checks:** applied with `migrate deploy` to the development database and to two new, empty databases; `migrate diff` between the database and the schema: no difference. The seed runs on a fresh database and gives consistent balances.
- **Serial custody:** the existing `/inventory` pages, permissions and serial installation at the visit are unchanged; the menu entry is now called "Serial custody".

| Check | Result |
|---|---|
| `npm run lint` | No errors |
| `npm run typecheck` | No errors |
| `npm test` (unit and integration) | 29 files, **233 / 233 passed**. 46 new: 25 posting-engine, catalogue, warehouse, concurrency and access tests, 6 stocktake tests, 4 API tests, 11 unit tests. The role test was updated for the new permissions; the old permissions are unchanged. |
| `npm run build` | Succeeded |
| `npm run test:e2e` | **33 / 33 passed** on a freshly migrated and seeded database. 4 new inventory tests (receipt and reversal; stocktake to adjustment; store keeper and technician limits; Arabic). The phone sweeps now include the 9 new pages. |
| Pages checked | Stock, documents, new receipt, transfer, ledger and products, in Arabic and English, at 390 and 1366 px: correct direction, **0 px** horizontal overflow |

Found and fixed while testing:
- **Outgoing stock refused by the guard.** Balance writes first used `INSERT … ON CONFLICT DO UPDATE`. PostgreSQL runs the no-negative trigger on the proposed row, with the bare negative quantity, before it notices the conflict, so every issue was refused. Balances are now updated in place, and a row is inserted only when stock first arrives at a location.
- **Costs wiped on edit.** Someone who may not see costs editing a draft would have cleared the costs already on it. Those costs are now kept.
- **Stocktake snapshot.** Where the warehouse allows negative stock, the snapshot can hold a negative system quantity, so the check constraint now covers only counted quantities. This was changed before the migration left the development database.

