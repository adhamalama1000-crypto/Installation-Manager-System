# ERP final QA report

Final report of the full-system audit and the operational upgrade (roles and permissions,
warehouse stocktaking, installation scheduling), 17 November 2026. Every figure comes from a run
made for this report. Nothing below is marked passed without having run.

**Completion: not 100%.** 71 features were identified. 68 are verified by executed tests or
sweeps. 3 are only partly tested (section 3). No test failed.

## 1. Figures

| | Count |
|---|---|
| Modules | 30 |
| Features identified | 71 |
| Tested (any executed evidence) | 71 |
| Passed: fully verified | 68 (66 by automated tests, 2 by executed sweeps) |
| Passed: partly verified | 3 |
| Failed | 0 |
| Blocked | 0 |
| End-to-end workflows tested | 18, all passed |
| Bugs found | 5 functional (B1–B5) + 4 security/dependency findings (S1–S4) |
| Bugs fixed | 5 of 5 functional, each with a regression test |
| Remaining | S1–S4 (decision or hosting details needed; none exploitable through current code paths except S2, which the per-account limit still bounds) |

## 2. Final check results

| Check | Baseline on `main` | Final (branch with #19, #20, #21) |
|---|---|---|
| Lint | 0 problems | 0 problems |
| Types | 0 errors | 0 errors |
| Unit and integration | 45 files, 364 tests passed | 49 files, 401 tests passed |
| Build | succeeds | succeeds |
| Browser (built app, fresh seeded database) | 48/48 passed | 58/58 passed |
| Migrations vs schema drift | none | none |
| API sweep without session | | 182/182 protected pairs → 401; 5 public pairs as designed |
| API sweep as 5 roles (every GET route) | | 0 server errors |
| Overflow sweep, new pages, 3 widths, 2 roles | | 0 problems |

CI on GitHub: green for #19 and #20. #21 was just opened and its CI is running.

## 3. Not fully verified (not counted as passed)

1. **Customers:** editing a customer's details or sites outside a booking. The list and search are
   tested; the edit path has no dedicated test.
2. **Late alerts:** the scheduler call with a configured `CRON_SECRET`. Only the refusal without a
   secret was exercised.
3. **Sales analytics:** a confirmed sale appears, but totals and breakdowns are not checked figure
   by figure.

## 4. Security

- Fixed: the hard-coded Admin checks for booking for others, editing anyone's bookings and
  scheduling overrides (B1, B2) are now grantable permissions with audit.
- Verified:
  - server-side checks on every route (sweeps)
  - same-origin writes
  - login rate limit
  - redaction of other people's customers on the company schedule (the data is not sent)
  - 404 for out-of-scope records
  - no self-escalation
- Open: S1 Next.js advisory (upgrade recommended), S2 `X-Forwarded-For` trust (needs hosting
  details), S3 no CSP, S4 `exceljs` → `uuid` (not reachable).

**Next.js security upgrade.** `next build` reports that Next.js 16.4.3 is affected by
GHSA-mfr8-8qww-v76h and recommends upgrading. The app does not use the affected feature, so
nothing is exploitable today. The upgrade was not run because changing the framework version is the
owner's decision. Recommended next step: run the Next.js security upgrade on its own branch and run
the full suite.

## 5. Database integrity

- All migrations are additive. Nothing existing was dropped or rewritten, and no record was
  deleted.
- Only throwaway databases were reset for testing.
- New tables:
  - access roles
  - stocktake schedules, counts and photos
  - technician working hours
  - reschedule requests
- Every new table that holds history refuses deletion (trigger) and has check constraints for its
  rules.
- Inventory stays transaction-safe:
  - balances change only through the posting engine
  - stocktake approval locks the stocktake and warehouse and checks the snapshot
  - reversal is the only correction

## 6. Tests added

- +37 unit and integration tests (364 → 401) and +10 browser tests (48 → 58).
- New files:
  - `tests/integration/access-roles.test.ts`
  - `tests/integration/stocktake-planning.test.ts`
  - `tests/unit/stocktake-schedule.test.ts`
  - `tests/integration/installation-scheduling.test.ts`
  - `e2e/roles.spec.ts`
  - `e2e/stocktake-planning.spec.ts`
  - `e2e/installation-scheduling.spec.ts`
- Tests extended: `e2e/responsive.spec.ts`.
- Changed only where behaviour changed on purpose, each with a comment saying why:
  - `scheduling`, `booking-details` and `booking-helpers` (overrides and the on-behalf permission)
  - `product-variants` and `e2e/inventory` (independent approver)
  - `lib.test` (pinned permission lists)
  - `field` and `expenses-car` e2e (override reason)

## 7. Files changed

| PR | Files | Lines |
|---|---|---|
| #19 roles and permissions | 31 | +1,578 / −212 |
| #20 warehouse and stocktaking | 59 | +4,057 / −171 |
| #21 installation scheduling (+ these audit documents) | 48 + 5 docs | +2,919 / −161, plus the documents |

## 8. Upgrade report (Critical ERP Upgrade, items 1–10)

1. **Reused:**
   - booking engine, overlap constraint, leave, holds, closed weekdays
   - stock ledger, posting engine, stocktake snapshot and freeze
   - permission registry, templates and audit log
   - visit execution: check-in, photos, evidence, checklist, outcome, payment
   - personal calendar
2. **New:**
   - custom roles; the Installation manager role
   - item lock, archive and specifications
   - stocktake schedules, recounts, separation of duties, supervisor approval, photos, dashboard
   - working hours; overrides with a reason
   - company schedule; reschedule requests
   - removal jobs; the technician's jobs today
3. **Database changes:** 6 additive migrations (see the three specifications).
4. **Permission matrix:** `ROLE_PERMISSION_MATRIX.md`, generated from the code.
5. **Stocktaking tests:** `WAREHOUSE_STOCKTAKING_SPECIFICATION.md` §5 and
   `OPERATIONAL_WORKFLOW_TESTS.md` §3.
6. **Technician tests:** `OPERATIONAL_WORKFLOW_TESTS.md` §4 (company schedule privacy, reschedule
   requests, jobs today) and the existing field-work tests.
7. **Scheduling conflict tests:** overlap, leave, working hours, day off, closed day, holds,
   invalid dates and durations, override with and without a reason
   (`i:installation-scheduling.test.ts`, `i:booking-details.test.ts`, `i:booking-helpers.test.ts`).
8. **Bugs:** `ERP_BUGS_AND_FIXES.md`.
9. **Limitations:** section 3 above. Also:
   - no public-holiday list (closed weekdays and leave only)
   - a partial stocktake still freezes the whole warehouse
   - damaged stock is recorded, not posted
10. **Final results:** section 2 above.

## 9. Decisions needing the owner's approval

The system currently follows the default named in each item.

1. **Store keepers creating products.** Default: no (a custom role adds it).
2. **Separation of duties for stocktakes.** Default: on (a one-person warehouse needs an Admin, or
   the setting turned off).
3. **Damaged stock at stocktake approval.** Default: recorded, not moved automatically.
4. **Partial stocktakes.** Default: the whole warehouse is frozen while open.
5. **Soft and hard scheduling rules.** Default: overlaps and leave are hard; hours, days off,
   closed days and holds can be overridden with a reason.
6. **Past dates.** Default: need the override permission, but no reason.
7. **Public holidays.** Should a list of holiday dates be added?
8. **Area on the company schedule** for other people's visits. Default: hidden.
9. **Sales see the company schedule.** Default: yes.
10. **A custom role clears individual permission changes.** Default: yes, as a change of role
    already did.
11. **Next.js security upgrade** (S1). Recommended.
12. **Login rate limit behind a proxy** (S2). Needs the hosting details.
13. **Content-Security-Policy** (S3). Recommended in report-only mode first.

## 10. Merge order

PRs #19 → #20 → #21. Each is stacked on the previous one. None is merged; merging waits for the
owner.
