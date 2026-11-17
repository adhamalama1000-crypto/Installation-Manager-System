# ERP full system audit

A senior QA, architecture and business review of the whole system, done on 17 November 2026
together with the operational upgrade (roles, stocktaking, scheduling). It records what the system
is, how it was tested, what was found, and what is left. Companion documents:
- `ERP_TESTING_MATRIX.md`: every feature and its evidence
- `ERP_END_TO_END_WORKFLOWS.md`: cross-module workflows
- `ERP_BUGS_AND_FIXES.md`: confirmed bugs, fixes and regression tests
- `ERP_FINAL_QA_REPORT.md`: the final figures and decisions needed

## 1. Method

1. **Discovery.** Read the schema (Prisma, migrations, triggers), every service, API route and page,
   the permission registry and the existing docs. Built the feature inventory.
2. **Baseline** on `main` (`fe25595`), before any change:

   | Check | Result |
   |---|---|
   | Lint | 0 problems |
   | Types | 0 errors |
   | Unit and integration | 45 files, 364 tests passed |
   | Build | succeeded (after the one-time Next.js advisory stop) |
   | Browser | 48 of 48 passed |

3. **Module testing.** For each module:
   - the existing automated tests, run and read for what they actually cover
   - new tests where the upgrade added behaviour
   - an API sweep (every route without a session, and every GET route as five roles)
   - a layout sweep (every page at 1024, 768 and 390 px, English and Arabic)
   - code reading of the permission and data-integrity paths
4. **Workflows.** Cross-module flows in the browser on the built app with a fresh seeded database.
5. **Fixes.** Each confirmed bug was fixed with a regression test, then the full suite was run
   again.

Safety rules kept throughout:
- Only throwaway databases (`installation_manager_ci`, `_test`, `_shadow`) were created, dropped or
  seeded. No development or production database was touched.
- No destructive Prisma command was run, no migration was edited after release, and no record was
  deleted.
- No test was weakened. Tests changed only where the intended behaviour changed, each with a
  comment saying why.
- `Legacy.gs` (real customer data) was never imported or used.

## 2. System overview

| Part | Technology |
|---|---|
| App | Next.js 16 App Router, React 19, TypeScript, Tailwind 4 |
| Data | PostgreSQL 16 via Prisma 6. 34 migrations, all additive. Database triggers protect audit logs, the stock ledger, stocktakes, locked items, roles, schedules and requests from deletion or silent change. |
| Validation | Zod, on the server for every write |
| Authorization | One permission list (`src/lib/permissions.ts`), a registry of modules, levels and scopes (`permission-registry.ts`), per-person grants and denies, custom roles, record scopes (all, team, own, assigned). Every service checks on the server (`assertCan`, `appointmentScope`). |
| Size | 60 pages, 143 API route files (187 route-method pairs), 49 services |
| Languages | Arabic (default, right to left) and English. Dictionary parity is tested. |
| Tests | Vitest unit and integration on a real database; Playwright browser tests on the built app |

## 3. Modules (30)

| Area | Modules |
|---|---|
| Access | Authentication and sessions; users, roles and permissions |
| Booking and schedule | Appointments; personal calendar; company schedule, working hours, reschedule requests; day plan |
| Field work | GPS check-in and live board; visit outcome and report; photos, signature and attachments; delivery checklist; work evidence |
| Money | Payments and cash custody; finance; transport expenses and car route; penalties and deductions |
| Customer care | Complaints, ratings and quality; customers |
| People | Attendance and points; leave |
| Inventory | Serial custody; products, variants, codes and images; Excel import/export; warehouses and bins; stock documents and ledger; stocktakes and planning; suppliers |
| Sales | Sales invoices; sales analytics |
| Administration | Settings; audit log; reports and exports; notifications; dashboard |
| Interface | Arabic/English and RTL; responsive layout |

## 4. Findings by area

### 4.1 Security and permissions
- **Strong:**
  - every protected route refuses without a session (sweep: 182/182)
  - writes need the same origin
  - login is rate-limited
  - generic login errors
  - out-of-scope records answer 404
  - Admin-only permissions cannot be stored for anyone else
  - nobody changes their own access
  - every access change is audited with before and after
- **Fixed:**
  - booking for others and editing anyone's bookings were Admin-only in code (B1)
  - scheduling overrides were Admin-only and unrecorded (B2)
- **Open:**
  - the login per-IP limit trusts `X-Forwarded-For` (S2)
  - no Content-Security-Policy (S3)
  - the Next.js advisory (S1, not exploitable)
  - an `exceljs` → `uuid` advisory (S4, not reachable)
- **Role sweep:** a technician, store keeper, viewer, Sales and Installation manager called every
  GET route. There were no server errors. Each reached only what its rules allow (for example, a
  technician sees only their own van's stock and ledger).

### 4.2 Data integrity
- The stock ledger is append-only; balances change only through the posting engine, in
  transactions with per-warehouse locks. Reversal is the only correction.
- Stocktakes freeze the warehouse, keep a snapshot, and post one adjustment on approval. Counts and
  recounts are append-only.
- Booking overlaps are prevented by a per-technician lock and a database exclusion constraint.
  Leave and holds take the same lock.
- Audit logs, roles, schedules, reschedule requests and stocktake history cannot be deleted
  (triggers).
- `prisma migrate diff` between a database built from the migrations and the schema shows no
  difference.

### 4.3 Business logic
- Business rules changed in this upgrade:
  - separation of duties for stocktakes
  - working hours
  - override with a reason
  - supervisor approval
- Each is documented with its default, and questions are listed for the owner.
- Where a rule was unclear, the system keeps the existing behaviour, and the question is in
  `ERP_FINAL_QA_REPORT.md`. Examples: whether damaged stock is posted automatically, public
  holidays, whether past dates need a reason.

### 4.4 Interface
- Confirmed layout bugs at tablet and phone widths were fixed (B3–B5).
- The overflow sweep of all pages, including every new one, now finds 0 problems.
- Arabic pages are right to left with Arabic statuses, dates, plurals and validation (browser tests).

## 5. What changed during the audit

| Change | Where |
|---|---|
| Custom roles, Installation manager role, permission-based booking for others (B1) | PR #19 |
| Item lock and archive, specifications, stocktake schedules, recounts, separation of duties, supervisor approval, photos, dashboard; layout fixes B3–B5 | PR #20 |
| Working hours, overrides with a reason (B2), company schedule, reschedule requests, removal jobs, technician's jobs today | PR #21 |
| Audit documents | this document set (PR #21) |

## 6. Remaining gaps (honest list)

- Not every feature has a dedicated functional test. Three are partial: customer edits outside a
  booking, late alerts with a configured scheduler, and analytics figures checked one by one. See
  `ERP_TESTING_MATRIX.md`.
- The open security items S1–S3 need the owner's decision or hosting details.
- The decisions listed in `ERP_FINAL_QA_REPORT.md` need the owner's answer. The system currently
  follows the documented defaults.
