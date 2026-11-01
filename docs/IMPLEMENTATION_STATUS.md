# Implementation status

This page is updated after each completed phase. The feature-by-feature comparison with Aura is in [FEATURE_MIGRATION_MATRIX.md](FEATURE_MIGRATION_MATRIX.md).

A phase is marked **done** only when its code is committed, and lint, typecheck, unit and integration tests, the production build and the browser tests all passed on that commit. A phase is **merged** only after the owner approves and merges its pull request.

## Delivered

| Work | Pull request | State |
|---|---|---|
| Performance fixes, Aura phases 1–6 (booking details, visit outcome, leave, payments, inventory, day plan) | #1 | Merged |
| Dashboard counters in one statement, auto-refresh paused while typing | #2 | Merged |
| Arabic-first interface (RTL) with an Arabic/English switch | #3 | Merged |

## Remaining Aura features

| Phase | Scope | Branch | State |
|---|---|---|---|
| A: Delivery proof | Photos, signature, payment and deposit proofs, delivery checklist, serial-required setting | `claude/aura-delivery-proof` | Done, #5 open (against `main`) |
| B: After-sales | Complaints, ratings, quality grade, satisfaction and quality lists, maintenance reminders | `claude/aura-after-sales` | Done, #6 open (stacked on #5) |
| C: Field tracking | GPS check-ins, live board, attendance, points, late alerts, automatic repeat-visit fee | `claude/aura-field-tracking` | Done, #7 open (stacked on #6) |
| D: Expenses and car | Transport expenses, Driver role, car route, car check-ins | `claude/aura-expenses-car` | Done, pull request open (stacked on phase C) |
| E: Booking helpers | Slot holds, quotation parsing, specialty suggestion, booking rules, site readiness | — | Not started |

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

