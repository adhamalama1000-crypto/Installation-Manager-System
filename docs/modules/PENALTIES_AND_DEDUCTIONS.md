# Penalties and deductions

## 1. Module purpose

Record violations by employees (late arrival, early leave, no clock-out, absence, rejected
attendance, work sent back, or anything recorded by hand) as **warnings** or **deductions**, with an
approval step before anything costs money, and hand finance exactly the deductions that were
approved, with a full and unchangeable record of every step. Before this module the system had
only monthly *points* (not money).

## 2. How users operate it

**Rules (Violations & deductions → Rules).** An Admin adds a rule: name (and Arabic name), *When*
(the trigger), *Penalty* (warning, fixed amount, or per minute for late arrival / early leave),
the amount, grace minutes, a cap, and "warnings first" (the first N occurrences in a month are only
warnings). Rules can be switched off; they are never deleted.

**Finding violations.** *Find violations* asks for a period (at most 62 days) and applies the
active rules to attendance and work reviews. Every case it finds is **proposed**; the result says
how many were proposed.

**Recording by hand.** *Record violation*: employee (searchable), date (not in the future), an
optional manual rule (it fills in the penalty), warning or deduction, amount, and what happened.
It is proposed only.

**Deciding.** The list opens on *Waiting for approval*. *Approve* lets the approver keep the
proposal, change it to a warning, or change the amount, with an optional note; *Reject* needs the
reason. Approved violations can be cancelled (*Cancel*, reason required); proposed ones can be
cancelled too.

**Finance.** The finance page shows *Approved deductions* for the month per employee, read only
from the deduction entries.

**Employees.** *My violations* shows the employee's own approved warnings and deductions and any
that were cancelled after approval. Proposed and rejected ones are not shown to them.

## 3. Available features

- Seven triggers: `MANUAL`, `LATE_ARRIVAL`, `EARLY_LEAVE`, `MISSING_CLOCK_OUT`, `ABSENCE`,
  `ATTENDANCE_REJECTED`, `WORK_REJECTED`.
- Three penalties: warning, fixed amount, per minute after grace minutes with an optional cap.
- Warnings first: the first N standing occurrences of a rule per employee per month are warnings.
- Idempotent scans (each source proposed once per rule, even when rejected).
- Approve as proposed / as a warning / with another amount; reject with reason; cancel with reason.
- Append-only history per violation and append-only finance entries (approval and reversal).
- Finance page card; violations list with status, employee and month filters and a summary;
  violation detail page with history and entries; employee page.
- Audit log entries (entity type `PENALTY`) and notifications: approvers when something is proposed,
  the employee when something is approved or an approved one is cancelled.

## 4. Roles and permissions

| Permission | Granted to | Allows |
|---|---|---|
| `penalties.view` | Admin, Accountant | See everyone's violations, rules and details |
| `penalties.manage` | Admin | Rules, record by hand, find violations, cancel proposed ones |
| `penalties.approve` | Admin | Approve, reject, cancel approved ones |
| `penalties.own` | Every role except Viewer | *My violations* (own decided ones only) |

Nobody decides on (or cancels an approved) violation against themselves; a violation recorded for
an Admin is decided by another Admin.

## 5. Business rules

- **Nothing is deducted without approval.** Rules and people only create `PROPOSED` violations.
- Only an approved **deduction** creates a finance entry (`APPROVAL`, the approved amount, for the
  month of the violation's date). Cancelling an approved deduction adds a `REVERSAL` entry of the
  same amount, negative, for the same month. Finance sums the entries.
- Status changes: `PROPOSED → APPROVED | REJECTED | CANCELLED`, `APPROVED → CANCELLED`; rejected and
  cancelled violations never change.
- Late / early minutes come from the attendance records (`lateMinutes` counts from the start of
  the working day once the company grace has passed; the rule's own grace minutes are subtracted).
- Per-minute amount = rate × counted minutes, capped; rounded to piastres.
- A scan skips a day whose attendance a manager already accepted, and absences / missing clock-outs
  of the current day. Attendance triggers need the scanning user to see everyone's attendance.
- Two scans at the same time cannot propose the same case twice (transaction-level advisory lock
  plus a unique `sourceKey`).

## 6. Database models and relationships

Migration `20261105140000_penalties_deductions` (new enums and tables only).

| Model / table | Notes |
|---|---|
| `PenaltyRule` / `penalty_rules` | name, nameAr, trigger, action, amount, graceMinutes, maxAmount, warningsFirst, description, isActive. CHECK: warning = 0, fixed / per minute > 0, ranges. |
| `Violation` / `violations` | number (`VIO-2031-000001`), userId (employee), ruleId, trigger, sourceKey (unique), occurredOn, minutes, kind, amount, proposedKind, proposedAmount, description, appointmentId, status, created / decided / cancelled by and when, decisionNote, cancelReason. CHECKs on amounts and on each status's required fields. Trigger `violations_guard`: never deleted, the record never changes, only the allowed status changes. |
| `ViolationEvent` / `violation_events` | Every step (proposed, approved, rejected, cancelled) with kind, amount, note, actor, time. Append-only. |
| `DeductionEntry` / `deduction_entries` | violationId, userId, month (YYYY-MM), signed amount, kind (`APPROVAL` / `REVERSAL`), createdBy. Unique per violation and kind; append-only; trigger `deduction_entries_guard` refuses an entry that does not match an approved (or cancelled approved) deduction and its amount. |

## 7. API routes

| Route | Method | Purpose |
|---|---|---|
| `/api/penalties` | GET, POST | List (`status`, `userId`, `month`, `page`); record by hand (201) |
| `/api/penalties/[id]` | GET | Detail with events and finance entries |
| `/api/penalties/[id]/decision` | POST | `{ decision, kind?, amount?, note }` |
| `/api/penalties/[id]/cancel` | POST | `{ reason }` |
| `/api/penalties/scan` | POST | `{ from, to }` |
| `/api/penalties/rules`, `/api/penalties/rules/[id]` | GET, POST / PATCH | Rules |
| `/api/finance` | GET | The monthly statement now includes `deductions` |

## 8. Services and important logic

- `src/lib/penalties.ts` (shared): `penaltyFor` (the calculation), schemas, constants.
- `src/server/services/penalties.ts`: rules, `recordViolation`, `scanViolations` (reads attendance
  through `attendanceRange`, the same function as the attendance pages, plus attendance and work
  reviews), `decideViolation`, `cancelViolation` (row lock `FOR UPDATE`), `listViolations`,
  `getViolation`, `deductionsForMonth` (used by `financeStatement`).
- UI: `src/app/(app)/penalties/**`, `src/components/penalties/*`, the deductions card in
  `src/app/(app)/finance/page.tsx`.

## 9. Validation rules

- Rule: name required; amount > 0 for fixed / per minute (two decimals); per minute only for late
  arrival and early leave; grace 0–600; warnings first 0–31.
- Manual violation: active employee, valid date not in the future, description required, amount
  > 0 for a deduction.
- Decision: reason required to reject; an approved deduction needs an amount > 0.
- Cancellation: reason required. Scan: valid dates, end not before start, at most 62 days.

## 10. Error handling

422 with field messages for invalid input (in the reader's language); 422 with a form message for
a wrong state ("Only a violation waiting for approval can be approved or rejected", "already
rejected or cancelled"); 403 without the right or when deciding on one's own violation; 404 for a
violation the reader may not see. The database guards raise errors for anything the services
would never do (direct SQL edits, deletes).

## 11. Tests

- `tests/integration/penalties.test.ts` (12 tests): rules (rights, validation, audit), scan
  (per-minute with grace and cap, warnings first, idempotent, nothing in finance), concurrent scans,
  every trigger (missing clock-out, absence, rejected attendance, work sent back), accepted days
  skipped, period checks, approval rights and self-approval, amount change kept with the proposal,
  approve as warning, finance totals, cancellation with reversal, employee visibility, manual
  recording, database guards.
- `tests/unit/penalties.test.ts`: the calculation and the forms.
- `tests/integration/erp-api.test.ts`: the routes (401/403/404/422/201, employee visibility).
- `e2e/penalties.spec.ts`: rule added, violation recorded with the rule's defaults, approved with
  a lower amount, finance card, employee page, access denied to the list, cancelled with reason and
  reversed.

## 12. Current limitations

- Finance shows approved deductions per month; there is no payroll run, payslip or export to an
  accounting system, and no "closed month" lock (a cancellation after payroll still reverses in
  the violation's month).
- Scans are started by a person (no scheduled job).
- Penalty rules are company-wide (no per-role or per-department rules).
- Points (the older attendance points) are separate and unchanged.

## 13. Future improvements

- Payroll month closing and export of deductions; a CSV of the finance card.
- A scheduled nightly scan for the previous day.
- Rules per role or team; escalation (third offence → higher amount).
- Employee acknowledgement of warnings.
