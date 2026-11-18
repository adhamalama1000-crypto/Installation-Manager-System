# ERP testing matrix

Every module and feature found during discovery, the evidence that it works, and its status.
Results are from the final runs on 17 November 2026 (branch `claude/installation-scheduling`,
which contains PRs #19, #20 and #21):
- unit and integration: 49 files, 401 tests, all passed
- browser: 58 tests, all passed
- route sweeps: every API route without a session and as five roles; layout sweeps

**Status key**
- **V-auto**: an automated test that exercises this feature ran and passed in the final run.
- **V-sweep**: verified by an executed sweep (API status sweep, overflow sweep at 1024/768/390 px,
  Arabic right-to-left check), not by a dedicated functional test.
- **Partial**: some paths are tested, others named in *Gaps* are not.
- **Not verified**: no automated or executed check in this audit. These are not counted as passed.

Test file names: `u:` = `tests/unit`, `i:` = `tests/integration`, `e:` = `e2e`.

## 1. Authentication and sessions

| Feature | Evidence | Status |
|---|---|---|
| Sign in / sign out, session cookie flags | i:auth-cookies, i:api, e:login | V-auto |
| Login rate limiting and lock-out | i:api | V-auto |
| Invitation and password set/reset links | i:admin-password | V-auto |
| Every API route refuses without a session | sweep: 182 of 182 protected route/method pairs → 401; public routes (login, logout, set-password, locale, cron without secret → 503) behave as designed | V-sweep |
| Same-origin check on writes | i:api | V-auto |

## 2. Users, roles and permissions

| Feature | Evidence | Status |
|---|---|---|
| Users: create, edit, deactivate, role change | i:users-audit-reports, i:access-control | V-auto |
| Individual permission grants/denies, data scopes, teams | i:access-control, i:access-api, i:permissions, e:permissions | V-auto |
| Templates per role | i:access-control, u:permission-registry | V-auto |
| Custom roles (create, edit, assign, deactivate rules, history) | i:access-roles, e:roles | V-auto |
| Installation manager role | i:access-roles, i:scheduling, i:installation-scheduling | V-auto |
| Escalation limits (no self-change, Admin-only permissions, Viewer read-only) | i:access-control, i:access-roles | V-auto |
| Server enforcement per role on every GET route | sweep as technician, store keeper, viewer, Sales, Installation manager: no 5xx; restricted roles reach only routes their rules allow | V-sweep |
| Default permission lists per role | u:lib (pinned lists) | V-auto |

## 3. Appointments and booking

| Feature | Evidence | Status |
|---|---|---|
| Create, edit, cancel, statuses, optimistic locking, idempotent create | i:scheduling, i:booking-details, e:appointments | V-auto |
| Technician overlap protection (lock + exclusion constraint), travel buffer | i:scheduling, i:hold-concurrency | V-auto |
| Leave blocks bookings | i:leaves, i:installation-scheduling | V-auto |
| Closed weekdays, past dates, holds: override with a reason | i:booking-details, i:booking-helpers, i:installation-scheduling | V-auto |
| Working hours and days off | i:installation-scheduling, e:installation-scheduling | V-auto |
| Slot holds and technician suggestion | i:booking-helpers, i:hold-concurrency, e:booking-helpers | V-auto |
| Visit types incl. Removal; customer confirmation; follow-up visits | i:booking-details, i:booking-followups, i:installation-scheduling | V-auto |
| Quotation link parsing | i:booking-helpers | V-auto |
| Booking for another Sales employee; editing others' bookings | i:scheduling, i:access-roles | V-auto |
| Appointment list, filters, CSV export | i:appointment-reads, e:appointments | V-auto |
| Appointment history (audit per field) | i:booking-helpers, i:users-audit-reports | V-auto |

## 4. Schedules

| Feature | Evidence | Status |
|---|---|---|
| Personal calendar: day, week, month, agenda; technician sees own only | i:appointment-reads (range query, scope); e:appointments (week and agenda views, Sales colours, details panel); e:access (technician sees only own appointments) | V-auto |
| Company schedule: day, week, month, filters, availability, workload | i:installation-scheduling, e:installation-scheduling | V-auto |
| Company schedule privacy (other customers hidden, not sent) | i:installation-scheduling, e:installation-scheduling | V-auto |
| Working hours editor | i:installation-scheduling, e:installation-scheduling | V-auto |
| Reschedule requests | i:installation-scheduling, e:installation-scheduling | V-auto |
| Technician's jobs today on the dashboard | e:installation-scheduling (Arabic, phone) | V-auto |
| Day plan with WhatsApp links | u:day-plan, i:day-plan, e:day-plan | V-auto |

## 5. Field work and visits

| Feature | Evidence | Status |
|---|---|---|
| GPS check-in / arrival, distance rules | u:field, i:field, e:field | V-auto |
| Visit outcome (completed, unable, needs revisit) and mandatory report | i:visit-outcome, e:visits | V-auto |
| Photos, signature, attachments (images, video limits) | i:attachments, e:delivery | V-auto |
| Delivery checklist and proof rules | e:delivery, i:attachments | V-auto |
| Work evidence and review | u:evidence, i:evidence, e:evidence | V-auto |
| Live board | e:field and e:expenses-car (the Admin sees the technician and the car on the live board) | V-auto |
| Late alerts (cron) | route refuses without secret (sweep) | Partial (gap: alert content not tested end to end) |

## 6. Money

| Feature | Evidence | Status |
|---|---|---|
| Price, deposit, extra fee, collection, cash custody hand-over | i:payments, e:payments | V-auto |
| Finance report | i:payments | V-auto |
| Transport expenses and payment | i:expenses-car, e:expenses-car | V-auto |
| Penalties and deductions | u:penalties, i:penalties, e:penalties | V-auto |

## 7. Customer care

| Feature | Evidence | Status |
|---|---|---|
| Complaints (open, assign, close, grade) | i:after-sales, e:complaints | V-auto |
| Customer rating, quality grade, maintenance reminders | i:after-sales | V-auto |
| Customers list and search (figures, permitted search fields) | i:appointment-reads; page in sweeps | Partial (gap: no dedicated test of editing a customer's details or sites outside a booking) |

## 8. People operations

| Feature | Evidence | Status |
|---|---|---|
| Attendance, clock in/out, points, work locations | i:attendance, e:attendance | V-auto |
| Leave requests and approval | i:leaves, e:leaves | V-auto |
| Company car route | i:expenses-car, e:expenses-car | V-auto |

## 9. Inventory and warehouse

| Feature | Evidence | Status |
|---|---|---|
| Serial custody (stock items, warranty) | i:stock, e:stock | V-auto |
| Products: create, edit, codes, barcodes, images, specifications | u:product-codes, i:inventory, i:stocktake-planning, e:products | V-auto |
| Product variants | i:product-variants | V-auto |
| Item lock, archive | i:stocktake-planning, e:stocktake-planning | V-auto |
| Excel import/export of products | i:product-import, e:import-suppliers | V-auto |
| Warehouses, bins, van warehouses | i:inventory | V-auto |
| Stock documents (receipt, issue, transfer, adjustment), posting, reversal | i:inventory, i:inventory-api, e:inventory | V-auto |
| Immutable ledger, balances, negative-stock rules | i:inventory (incl. database triggers) | V-auto |
| Stocktakes (snapshot, freeze, count, approve) | i:stocktakes, e:inventory | V-auto |
| Stocktake schedules, recounts, separation of duties, supervisor, photos, dashboard | u:stocktake-schedule, i:stocktake-planning, e:stocktake-planning | V-auto |
| Suppliers | i:erp-api, e:import-suppliers | V-auto |

## 10. Sales

| Feature | Evidence | Status |
|---|---|---|
| Sales invoices, stock out, void | i:sales, e:sales | V-auto |
| Sales people list | i:sales-people | V-auto |
| Sales analytics | e:sales (a confirmed sale appears in the analytics) | Partial (gap: totals and breakdowns are not checked figure by figure) |

## 11. Administration

| Feature | Evidence | Status |
|---|---|---|
| Settings (closed weekdays, hours, rules) | i:booking-details, i:stocktake-planning | V-auto |
| Audit log (immutable, filters, export) | i:users-audit-reports | V-auto |
| Reports and exports | i:users-audit-reports, i:appointment-reads | V-auto |
| Notifications | i:installation-scheduling, i:leaves | V-auto |
| Dashboard counts and needs-attention list | i:booking-details | V-auto |

## 12. Interface

| Feature | Evidence | Status |
|---|---|---|
| Arabic and English, plural forms, dictionary parity | u:i18n, e:arabic | V-auto |
| Right-to-left layout | e:arabic, e:stocktake-planning, e:installation-scheduling, e:roles | V-auto |
| Responsive: no horizontal overflow at 1024/768/390 px | e:responsive; overflow sweep of all new pages as manager and technician (0 problems) | V-auto + V-sweep |
| Forms: required fields, errors next to fields | u:forms, browser tests | V-auto |

## 13. Totals

| | Count |
|---|---|
| Modules | 30 (grouped in 12 sections above) |
| Features listed | 71 |
| V-auto | 66 |
| V-sweep only | 2 |
| Partial | 3 |
| Not verified | 0 |
| Failed in the final run | 0 |

The 3 partial features are listed in `ERP_FINAL_QA_REPORT.md` as remaining test
gaps. They are not counted as passed.
