# Operational workflow tests

The automated tests behind the operational upgrade (roles and permissions, warehouse stocktaking,
installation scheduling): what each one proves, where it is, and the result of the last run. Every
result below comes from an actual run, not from reading the code.

- **Integration tests** (`tests/integration/*.test.ts`) call the services against a real,
  disposable PostgreSQL database (`TEST_DATABASE_URL`) with every migration applied, so the
  database triggers, checks and locks are part of what is tested.
- **Browser tests** (`e2e/*.spec.ts`, Playwright, Chromium) drive the built app (`next build` and
  `next start`) on a freshly migrated and seeded throwaway database, in English and Arabic, at
  desktop and phone widths.
- No test uses production data. The seed holds demo people and data only.

## 1. Results of the last run

| Check | Command | Result |
|---|---|---|
| Lint | `npm run lint` | 0 problems |
| Types | `npx tsc --noEmit` | 0 errors |
| Unit and integration | `npx vitest run` | 49 files, 401 tests, all passed |
| Build | `npm run build` | succeeds (the first run stops once to show the Next.js security advisory, the retry builds) |
| Browser | `npx playwright test` on the built app | 58 tests, all passed (fresh database) |
| Migrations vs schema | `prisma migrate diff` from a database built by `migrate deploy` | no difference |
| Horizontal overflow sweep | every new page at 1024, 768 and 390 px, as manager and technician | 0 problems |

Last run: 17 November 2026, branch `claude/installation-scheduling` (stacked on the Phase 1 and Phase 2
branches).

## 2. Roles and permissions (Phase 1)

| Workflow | Test | Proves |
|---|---|---|
| An Admin creates a custom role from a base role | `access-roles.test.ts` | Starts from the base role's defaults; the role's permissions and scopes apply to its people, with individual changes on top |
| Editing a role | `access-roles.test.ts` | Its people's access changes on their next request; audited with before and after |
| Escalation limits | `access-roles.test.ts` | Never Admin-only permissions; a Viewer-based role stays read-only; base role fixed; only for people of that base role; only Admins manage roles; nobody changes their own |
| Role lifecycle | `access-roles.test.ts` | Cannot be deactivated while in use; never deleted (trigger); cleared when the person's base role changes |
| Installation manager template | `access-roles.test.ts`, `scheduling.test.ts` | Books for Sales and edits anyone's bookings; no money, stock movements, users or settings |
| Server enforcement in the browser | `e2e/roles.spec.ts` | The role is created in the UI, given to a Sales employee, and the API refuses what it removed |
| Arabic, phone | `e2e/roles.spec.ts` | Roles page right to left, no overflow |
| Default permissions per role | `tests/unit/lib.test.ts` | Pinned lists per built-in role (changes need an explicit test change) |

## 3. Warehouse stocktaking (Phase 2)

| Workflow | Test | Proves |
|---|---|---|
| Item lock | `stocktake-planning.test.ts`, `e2e/stocktake-planning.spec.ts` | A locked item cannot be edited by the service or directly in the database; stock still moves; only `products.unlock` unlocks; UI lock and unlock |
| Item archive | `stocktake-planning.test.ts` | Only without stock and not while locked; hidden, read-only, brought back inactive |
| Specifications | `stocktake-planning.test.ts` | Stored and validated |
| Schedules (daily, monthly, annual, once) | `stocktake-schedule.test.ts`, `stocktake-planning.test.ts` | Occurrence dates (month ends, 29 February, end date); sessions planned ahead with no duplicates even when planning runs twice at the same moment |
| Editing and ending a schedule | `stocktake-planning.test.ts` | Untouched planned sessions follow; postponed sessions keep their time; ending cancels |
| Session controls | `stocktake-planning.test.ts` | Planners only; postponing needs a reason; a mandatory session is cancelled only with a reason |
| 100 in the system, 95 counted, 2 damaged | `stocktake-planning.test.ts`, `e2e/stocktake-planning.spec.ts` | Difference −5 recorded; no balance change until approval; approval posts the −5 adjustment to the ledger; finalized sessions locked |
| Separation of duties | `stocktake-planning.test.ts`, `e2e/inventory.spec.ts` | Whoever counted or submitted cannot decide; the page says why; the setting turns it off |
| Supervisor approval | `stocktake-planning.test.ts` | Only the supervisor or a planner, and only with `inventory.approve` |
| Recount | `stocktake-planning.test.ts` | Every count kept (append-only history); resubmission refused until recounted |
| Unauthorized people | `stocktake-planning.test.ts` | Cannot count, adjust or plan; photos must be images |
| Dashboard | `stocktake-planning.test.ts` | Overdue, pending approval, discrepancies, warehouse record |
| Arabic, phone | `e2e/stocktake-planning.spec.ts` | Dashboard, schedules and list right to left, no overflow |

## 4. Installation scheduling (Phase 3)

| Workflow | Test | Proves |
|---|---|---|
| Working hours | `installation-scheduling.test.ts`, `e2e/installation-scheduling.spec.ts` | Manager only; validated (end after start, all seven days); updated in place; audited; database check; set in the UI with the error shown on the day |
| Booking outside hours or on a day off | `installation-scheduling.test.ts`, e2e | Refused with the technician's hours named; technicians without hours unrestricted; bookings without technicians unrestricted |
| Override with a reason | `installation-scheduling.test.ts`, `booking-details.test.ts`, `booking-helpers.test.ts`, e2e | Sales cannot override; the manager (or Admin) is refused without a reason and accepted with one; the audit entry holds the rules and the reason; the booking form shows *Outside working hours* and the reason field |
| Hard rules | `installation-scheduling.test.ts`, `scheduling.test.ts` | Overlaps and approved leave are refused even with a reason; invalid dates and durations refused |
| Availability | `installation-scheduling.test.ts` | *Outside hours* and *day off* flags; a visit past midnight checked on both days |
| Company schedule privacy | `installation-scheduling.test.ts`, e2e | A technician sees every technician's time but only their own customers (other customers' names and phones are not in the data at all); visibility follows the reader's scope; read-only |
| Company schedule content | `installation-scheduling.test.ts`, e2e | Hours, days off, leave, closed days, workload, availability counts, day, week and month ranges, filters; cancelled visits hidden |
| Reschedule requests | `installation-scheduling.test.ts`, e2e | Only the assigned technician asks; the booker and managers are notified; one open request; decline needs a note; answers are final and notified; history, audit, no delete; finished visits refused; the manager answers from the company schedule and the technician sees it on the visit |
| Removal jobs | `installation-scheduling.test.ts`, e2e | Booked and shown like other job types |
| Technician's jobs today | e2e (Arabic, phone) | The dashboard lists today's job with its details |
| Arabic, phone | e2e | Day, week and month views and working hours right to left, no overflow |
| Existing technician workflows | `e2e/field.spec.ts`, `e2e/visits.spec.ts`, `e2e/delivery.spec.ts`, `e2e/evidence.spec.ts`, `e2e/leaves.spec.ts` | Check-in with GPS, photos and evidence, delivery checklist, outcome reporting and leave keep working |

## 5. How to run them

```bash
# Unit and integration (needs TEST_DATABASE_URL pointing to a disposable database)
npx vitest run

# Browser tests against a built app on a throwaway, freshly seeded database
npm run build
DATABASE_URL=<throwaway> npx prisma migrate deploy && DATABASE_URL=<throwaway> npx prisma db seed
DATABASE_URL=<throwaway> npx next start -p 3011 &
E2E_BASE_URL=http://localhost:3011 npx playwright test --trace off
```

Never point `TEST_DATABASE_URL` or the browser tests at a development or production database: the
integration tests empty their database before each test.
