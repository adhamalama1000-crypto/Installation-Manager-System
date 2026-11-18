# ERP end-to-end workflows

The business workflows that cross modules, how each was tested end to end, and the result. Every
workflow below ran in the final browser run (58 tests, all passed, built app on a fresh seeded
database) or the final integration run (401 tests, all passed). Workflows without such a test are
listed at the end as untested.

| # | Workflow | Steps covered | Test | Result |
|---|---|---|---|---|
| W1 | Sales books an installation | Sales signs in, creates customer and booking, chooses technicians from live availability, sees a conflict for a busy technician, saves | `e:appointments.spec.ts`, `e:booking-helpers.spec.ts`, `i:api.test.ts` (409 on double booking) | Passed |
| W2 | Technician does the visit | Technician sees today's job, checks in with GPS at the site, records photos, delivery checklist, serials, outcome and report, collects payment | `e:field.spec.ts`, `e:delivery.spec.ts`, `e:visits.spec.ts`, `e:payments.spec.ts` | Passed |
| W3 | Cash custody to finance | Technician collects; finance receives the custody; the finance report shows it | `i:payments.test.ts`, `e:payments.spec.ts` | Passed |
| W4 | Work evidence review | Evidence rules, technician uploads, head reviews, penalties follow | `e:evidence.spec.ts`, `i:evidence.test.ts`, `i:penalties.test.ts` | Passed |
| W5 | Complaint after a visit | Sales opens a complaint on a visit, head assigns and grades, rating recorded | `e:complaints.spec.ts`, `i:after-sales.test.ts` | Passed |
| W6 | Leave and bookings | Technician asks for leave, Admin approves, bookings on those days are refused and clashing bookings flagged | `e:leaves.spec.ts`, `i:leaves.test.ts` | Passed |
| W7 | Attendance and points | Clock in/out at a work location, daily attendance, points | `e:attendance.spec.ts`, `i:attendance.test.ts` | Passed |
| W8 | Car route and expenses | Bookings needing the car, driver route and check-ins, transport expenses paid | `e:expenses-car.spec.ts`, `i:expenses-car.test.ts` | Passed |
| W9 | Stock receipt to sale | Warehouse manager adds a product, receives and reverses a receipt; store keeper prepares an adjustment but cannot post it; a technician sees only their van; Sales confirms a sale and it reaches the analytics; transfers, ledger and balances agree (service tests) | `e:inventory.spec.ts`, `e:sales.spec.ts`, `i:inventory.test.ts`, `i:sales.test.ts` | Passed |
| W10 | Planned stocktake | Manager plans a stocktake for a store keeper; store keeper starts, counts 95 of 100 with 2 damaged, explains, submits; manager (who did not count) approves; the −5 adjustment is posted to the ledger | `e:stocktake-planning.spec.ts`, `i:stocktake-planning.test.ts` | Passed |
| W11 | Item lock | Manager locks an item; the edit form disappears; the API refuses changes; store keeper cannot unlock; unlock restores editing | `e:stocktake-planning.spec.ts` | Passed |
| W12 | Products import | Excel import of products and suppliers with row errors | `e:import-suppliers.spec.ts`, `i:product-import.test.ts` | Passed |
| W13 | Custom role | Admin creates a custom role, gives it to a Sales employee, the server enforces it | `e:roles.spec.ts`, `i:access-roles.test.ts` | Passed |
| W14 | Individual permissions | Admin removes a permission from one person; pages and API refuse it | `e:permissions.spec.ts`, `e:access.spec.ts` | Passed |
| W15 | Working hours and override | Installation manager sets a technician's hours; Sales cannot book outside them; the manager is refused without a reason and accepted with one; the audit holds the reason; the company schedule shows it; the booking form flags *Outside working hours* | `e:installation-scheduling.spec.ts`, `i:installation-scheduling.test.ts` | Passed |
| W16 | Reschedule request | Technician reads the company schedule (other customers hidden), asks to reschedule their job; the manager marks it done; the technician sees the answer | `e:installation-scheduling.spec.ts`, `i:installation-scheduling.test.ts` | Passed |
| W17 | Day plan | Manager sends the next day's plan by WhatsApp links | `e:day-plan.spec.ts` | Passed |
| W18 | Arabic, phone | Login in Arabic; dashboard, schedule, stocktake and roles pages right to left without horizontal scroll at 390 px; the technician's jobs today | `e:arabic.spec.ts`, `e:responsive.spec.ts`, Arabic tests in `stocktake-planning`, `installation-scheduling`, `roles` | Passed |

## Untested end to end

- **Customer master data edits outside a booking** (renaming a customer, adding a site from the
  customer page). Covered by service reads only.
- **Sales analytics figures.** A confirmed sale is shown, but totals and breakdowns are not checked
  figure by figure.
- **Late alerts from the scheduler.** Needs `CRON_SECRET` and a scheduler; tested only up to the
  refusal without a secret.

These are listed as gaps in `ERP_FINAL_QA_REPORT.md`, not as passed.
