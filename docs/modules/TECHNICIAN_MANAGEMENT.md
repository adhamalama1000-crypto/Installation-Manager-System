# Technician management

## 1. Module purpose

Everything the company needs to run its field team in one place: who the technicians are and what
they install, their schedule and assignments, leave, where they are during the day, their vehicle
stock, their attendance, the quality of their work, and their warnings and deductions. Most of this
existed before the upgrade; the upgrade added attendance with photos and geofences, work evidence
and review, and violations / deductions. This page ties the pieces together; details are in the
linked module pages.

## 2. How users operate it

| Task | Where | Detail page |
|---|---|---|
| Add a technician, set specialty (locks, smart home, both), phone, active | *Users* | `AUTHENTICATION.md`, `PERMISSIONS.md` |
| Assign technicians to visits (double booking refused, leave respected, availability suggestions) | Booking form, calendar | — |
| Leave, sick leave, absence: request, approve / reject, cancel | *Leave* (`/leaves`) | — |
| Daily check-ins at each stage of a visit; live board | Visit page, *Live board* | `GPS_TRACKING.md` |
| Clock in / out with photo; daily attendance and review | *Clock in / out*, *Attendance today* | `ATTENDANCE.md` |
| Monthly attendance and points | *Attendance & points* | `GPS_TRACKING.md` |
| Van stock, issues to visits, serial custody | *My van stock*, stock documents, *Serial custody* | `INVENTORY.md` |
| Photos, video, signature, evidence review | Visit page, *Work review* | `WORK_EVIDENCE.md` |
| Quality grade and customer rating per visit | *After-sales* | — |
| Warnings and deductions | *Violations & deductions*, *My violations* | `PENALTIES_AND_DEDUCTIONS.md` |
| Transport expenses | *Transport expenses* | — |

## 3. Available features

Technician accounts with specialty; assignment with conflict prevention (advisory locks plus a
database exclusion constraint on overlapping assignments); leave that blocks booking; visit-stage
check-ins with location; live board and late alerts; clock-in / out with live photo and geofences;
attendance reports and review; vehicle warehouses and serial custody; delivery checklist, photos,
video and signature; evidence rules and review; quality grades and ratings; points; violations and
deductions with approval; transport expenses.

## 4. Roles and permissions

Technicians: `appointments.view` (own assignments), `visits.report`, `checkins.record`,
`leaves.request`, `stock.view`, `inventory.view` (own vehicle), `complaints.view`, `expenses.record`,
`penalties.own`, and `customers.contact` when the setting allows. Management actions need
`leaves.manage`, `attendance.manage`, `evidence.review`, `penalties.*`, `quality.grade`,
`users.manage` (see `PERMISSIONS.md`).

## 5. Business rules

- A technician sees only their own assignments, vehicle stock, photos and decided violations.
- A technician on approved leave cannot be booked for those days.
- One vehicle per technician; vehicles are created by hand.
- Attendance, check-ins, reviews, violations and deductions are never edited after the fact; managers
  add reviews and decisions as new records.

## 6. Database models and relationships

`users` (role `TECHNICIAN`, `specialty`, `vehicle` → `warehouses`), `appointment_technicians`,
`technician_leaves`, `check_ins`, `technician_positions`, `attendance_reviews`, `work_locations`,
`work_reviews`, `violations`, `deduction_entries`, `transport_expenses`, `stock_items` (custody).

## 7. API routes

`/api/users`, `/api/leaves` (+ decision, cancel), `/api/check-ins`, `/api/attendance/*`,
`/api/appointments/[id]/outcome`, `/api/appointments/[id]/evidence*`, `/api/penalties*`,
`/api/expenses*`, `/api/stock*`, `/api/inventory/*`.

## 8. Services and important logic

`users.ts`, `scheduling.ts`, `leaves.ts`, `field.ts`, `attendance.ts`, `appointments.ts`
(`recordVisitOutcome`), `evidence.ts`, `penalties.ts`, `expenses.ts`, `stock.ts`, `inventory-*.ts`.

## 9. Validation rules

See each module; technician-specific: specialty values, leave dates (start ≤ end, no overlap with
existing leave), one vehicle per technician.

## 10. Error handling

Booking a technician on leave or already booked returns a conflict with the details; actions outside
a technician's scope return 404.

## 11. Tests

`tests/integration/scheduling.test.ts`, `leaves.test.ts`, `field.test.ts`, `attendance.test.ts`,
`evidence.test.ts`, `penalties.test.ts`, `expenses-car.test.ts`, `inventory.test.ts` (vehicle scope),
`e2e/visits.spec.ts`, `field.spec.ts`, `attendance.spec.ts`, `evidence.spec.ts`, `penalties.spec.ts`,
`leaves.spec.ts`, `permissions.spec.ts`.

## 12. Current limitations

No salary or payroll records (deductions are listed per month for finance); no skills matrix beyond
the specialty; no technician performance dashboard combining attendance, quality and violations in
one view (each is on its own page).

## 13. Future improvements

A technician scorecard page (attendance, punctuality, evidence approval rate, ratings, violations);
skills and certifications; payroll export.
