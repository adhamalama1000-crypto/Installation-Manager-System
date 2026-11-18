# Installation scheduling: specification

What technicians, the Installation Manager and Sales can do with the schedule, the rules the system
enforces, and where each rule lives in the code. Phase 3 of the operational upgrade. It builds on
the existing booking engine (`docs/modules/APPOINTMENTS.md` and the technician overlap constraint),
leave (`technician_leaves`) and slot holds, and changes none of their history.

## 1. What already existed and is reused

| Capability | Where |
|---|---|
| Bookings with one or more technicians, statuses, visit types, Sales colour, customer and site | `services/appointments.ts`, `/appointments` |
| Technician overlap protection: a per-technician advisory lock plus the database exclusion constraint `appointment_technicians_no_overlap` (with the travel buffer) | `services/scheduling.ts` |
| Approved leave blocks bookings on those days | `services/leaves.ts`, `assertTechniciansNotOnLeave` |
| Company closed weekdays and opening hours | *Settings* (`closedWeekdays`, `dayStartHour`, `dayEndHour`) |
| 10-minute slot holds while Sales is on the phone; "best technician" suggestion | `services/booking-helpers.ts` |
| Personal schedule (day, week, month, agenda), own visits only for technicians | `/calendar` (record scope *Assigned*) |
| Technician job execution: check-in with GPS and arrival, photos and evidence, delivery checklist, serials and materials, outcome (completed, unable to complete with the problem, needs another visit), payment collection | visit page `/appointments/[id]` |
| Sales employee on each booking (colour bar, name) | every booking view |

## 2. New in this phase

### 2.1 Removal jobs

The visit type **Removal** (`VisitType.REMOVAL`) joins Inspection, Installation, Completion,
Programming and Maintenance. The spec's four job types map to: **New installation → Installation**,
**Maintenance/Repair → Maintenance**, **Removal/Dismantling → Removal**, **Inspection →
Inspection** (Completion and Programming are kept).

### 2.2 Technicians' working hours

*Company schedule → Working hours* (`/schedule/hours`, permission `schedule.manage`). For each
technician and weekday, one of:
- **Set hours** (start and end, company timezone)
- **Working, no set hours**
- **Day off**

A technician with no hours saved keeps today's behaviour (no working-hours restriction). Rows are
updated in place, never deleted; each change is audited (`WORK_HOURS_UPDATED`, with before and
after per weekday and the optional reason). The database refuses impossible rows (an end before its
start, a day off with times) with a check constraint.

### 2.3 Conflict protection and overrides

| Rule | Kind | Message |
|---|---|---|
| Another visit of the same technician overlaps (with the travel buffer) | **Hard**: never overridable | The conflicting visit is named |
| Approved leave on that day | **Hard** | The leave is named |
| Invalid date, time or duration (15 minutes to 24 hours) | **Hard** (validation) | Field message |
| Outside the technician's working hours | Soft | "Hany works 09:00–17:00 on Sunday." |
| The technician's day off | Soft | "Friday is Hany's day off." |
| A company closed day (Settings) | Soft | "Friday is a closed day." |
| Someone else is holding the technician (slot hold) | Soft | "Hany is being held by Sara until 10:40." |
| A date that has passed | Soft, no reason needed | "This date has passed." |

**Override.** People with `appointments.override` (Admin and Installation manager by default) may
book over a soft rule by giving a **reason**. Without the permission the booking is refused with
the rule's message. With the permission but without a reason, it is refused with the same message
and a request for the reason (field *Reason for overriding the schedule* in the booking form, which
appears when the date or a chosen technician needs it). The rules overridden and the reason are
stored in the audit entry of the booking (`changes.overrides = { rules, reason }` and the entry's
`reason`), on creation or on the edit that needed it.

Implementation: `Overrides` in `services/appointments.ts` (create and update), working hours in
`services/work-hours.ts` (`workingHoursViolations`, checked on every company-local day a booking
touches, so a visit past midnight is checked on both days). The booking form shows *Outside working
hours* or *Day off* next to the technician (from `/api/appointments/availability`); people who
cannot override cannot tick that technician.

**When the rules are checked.** On a new booking; on an edit, when the date (closed day, past date)
or the time or technicians (hours, day off, holds) change. Editing other fields of an existing
booking never asks for an override. A status that does not block the schedule (for example
*Cancelled*) is not checked.

### 2.4 Company schedule

*Company schedule* (`/schedule`, permission `schedule.global`: Admin, Installation manager, Sales,
Technician by default). Read-only.

- **Views:** day, week, month; previous, today, next.
- **Filters:** technician, job type, status (unknown values in the address are ignored).
- **Per technician and day:** working hours, day off, leave, company closed day; the jobs (time,
  job type, status); booked time against working time, as a bar.
- **Availability overview:** per day, how many technicians are free, partly booked, fully booked,
  and off or on leave.
- **Month view:** jobs per day and free technicians; a day opens the day view.
- **Privacy:** customer details (code, name, area, link) appear only on visits the reader may
  already open (their appointment scope, or `appointments.manageAll`). On anyone else's visit the
  reader sees the time, the job type and the status, and "Customer details hidden". Phone numbers
  and addresses never appear on this page. The server builds the page without the hidden data, so
  it is not in the HTML or the API response (`/api/schedule`).
- Cancelled visits (statuses that do not block the schedule) do not appear.

### 2.5 Installation Manager's controls

The Installation manager (built-in role, or any role with these permissions) has:
- every booking: create, edit, reschedule, cancel, assign and reassign one or more technicians,
  book for a Sales employee, edit anyone's bookings (`appointments.manageAll`, Phase 1)
- the company schedule with every customer visible, availability and workload
- working hours (`schedule.manage`)
- overrides with a reason (`appointments.override`)
- leave approval (existing), so technicians' leave is part of availability
- open reschedule requests, at the top of the company schedule

### 2.6 Reschedule requests

On a visit assigned to them (and not finished), a technician (`visits.report`) can **Ask to
reschedule**: a reason (required) and an optional proposed date and time. One open request per
visit.
- The person who booked the visit and everyone with `appointments.manageAll` are notified.
- The technician never moves the booking. Whoever may edit it moves it (Edit), then marks the
  request **Done**, or **Declines** it with a note the technician sees. The technician is notified
  either way.
- Requests are never deleted (database trigger). Each step is audited on the visit
  (`RESCHEDULE_REQUESTED`, `RESCHEDULE_RESOLVED`).
- Code: `services/reschedule-requests.ts`, `components/schedule/reschedule.tsx`.

### 2.7 Technician's dashboard

For technicians the dashboard's today card becomes **My jobs today**. For each job: time, code,
status, job type and product; customer and phone (tap to call); address with building, floor,
apartment and area, and *Open location*; job notes (description, equipment, notes, access
instructions); the Sales employee who booked it; the other technicians on the job; *Open job*. All
of it comes from the same service as the visit page, so the same permissions apply (a technician
without `customers.contact` does not see phone numbers). The personal schedule (`/calendar`, day,
week and month, own visits only) is unchanged.

## 3. Database changes (additive)

- `20261118090000_visit_type_removal`: enum value `REMOVAL`.
- `20261118090100_work_hours_reschedule`:
  - table `technician_work_hours` (one row per technician and weekday; checks on weekday and times)
  - enum `RescheduleRequestStatus` and table `reschedule_requests` (checks: reason not blank, an
    answer exactly when not open; no-delete trigger)
- Existing rows are unchanged. Rollback notes are at the top of each file.

## 4. Permissions

| Permission | What it allows | Default roles |
|---|---|---|
| `schedule.global` | Read the company schedule | Admin, Installation manager, Sales, Technician |
| `schedule.manage` | Set technicians' working hours | Admin, Installation manager |
| `appointments.override` | Book over soft rules with a reason; book a past date | Admin, Installation manager |
| `appointments.manageAll` | Book for others, edit anyone's bookings | Admin, Installation manager |
| `visits.report` | Ask to reschedule an assigned visit (and record outcomes) | Technician (and managers) |

All are configurable per person or custom role (see `ROLE_PERMISSION_MATRIX.md`). Every check is
on the server; the pages only hide what the server would refuse.

## 5. Tests

- **`tests/integration/installation-scheduling.test.ts`** (8 tests):
  - working hours: manager only, validation, updated in place, audit, database check
  - bookings outside hours and on days off refused; technicians without hours unrestricted
  - override: Sales cannot; manager needs a reason; the audit records rules and reason; a later
    edit needs no new override
  - hard rules (overlap, leave, invalid date or duration) are not overridable
  - availability shows *outside hours* and *day off*; a visit past midnight is checked on both days
  - removal jobs
  - company schedule: the technician sees everyone's time but only their own customers (nothing
    else in the data); scope-based visibility for Sales; leave, days off, closed days and
    availability counts; month range; filters; cancelled visits hidden; refused without
    `schedule.global`
  - reschedule requests: who may ask and answer, notifications, one open request, decline note,
    final answers, history, audit, no delete, finished visits refused
- **`tests/integration/booking-details.test.ts`** and **`booking-helpers.test.ts`** updated: a
  closed day and someone else's hold now need `appointments.override` with a reason, also for
  Admins.
- **`e2e/installation-scheduling.spec.ts`**:
  - working hours set in the UI (and an invalid day refused); Sales refused outside them; the
    manager refused without a reason, then accepted with one; the company schedule shows the
    hours and the job; the booking form shows *Outside working hours* and asks for the reason
  - a technician reads the company schedule (other customer hidden, removal job shown), cannot
    change hours, asks to reschedule; the manager marks it done; the technician sees the answer
  - Arabic at phone width: day, week and month views and working hours fit; the technician's
    dashboard lists today's job
- `e2e/field.spec.ts` and `e2e/expenses-car.spec.ts`: their Admin bookings on today send an
  override reason (today may be a closed day).

## 6. Decisions for the owner

1. **Soft and hard rules.** Overlaps and approved leave are never overridable; working hours, days
   off, closed days and holds are, with a reason. Is that the split you want?
2. **Past dates** need the override permission but no reason (as Admins could before). Should a
   reason be required too?
3. **Public holidays.** The company has closed weekdays (Settings) and technicians have leave, but
   there is no list of public holiday dates. Should one be added (it would act like a closed day)?
4. **Area on the company schedule** is treated as a customer detail and hidden on other people's
   visits. Showing it would help plan travel. Should it be shown?
5. **Sales see the company schedule** by default (needed to see who is free when booking).
6. **Working hours apply only to technicians who have them.** Technicians without hours keep the
   company's opening hours as a guide only (no refusal), as before.
