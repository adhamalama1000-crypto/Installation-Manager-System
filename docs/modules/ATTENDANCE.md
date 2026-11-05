# Attendance

## 1. Module purpose

Record when field staff start and end their working day, where they were, and a live photo of
them, so managers can trust the attendance record and see lateness, early leave, absences and
missing clock-outs every day. The time always comes from the server; the location comes from the
phone with its accuracy; the photo comes from the live camera. Builds on the check-ins that
already existed (`check_ins`, `src/server/services/field.ts`).

## 2. How users operate it

**Technician / driver – Clock in / out (`/attendance/clock`).** The page asks for the location
and shows its accuracy ("Accuracy ±15 m") before anything is sent. The person chooses *Where*:
the company, today's customer visit, or an approved work location; takes a photo with *Take photo*
(front camera; *Retake* is possible) and presses *Clock in* (later *Clock out*). A fresh location
reading is taken at the moment of sending. The result says whether it was recorded normally,
outside the geofence, without a location or with a poor reading. Once clocked out the page shows
the day as done.

**Dashboard.** The *My day* card still has the quick company check-in buttons; when Settings
require a photo they send the person to the clock page instead.

**Managers – Attendance today (`/attendance/daily`).** Choose a day (or a range for weekly or
monthly views): each person's status (present, late, absent, on leave, day off, not yet), clock-in
and clock-out with time, place, distance from the expected place, accuracy and photo, worked time,
missing clock-outs, the day's visits and the summary per person. Flagged days have *Review*:
accept or reject with a note (a rejection needs it). Approved work locations are managed on the
same page. A CSV report is available from `/api/attendance/report`.

**Monthly attendance and points (`/attendance`)** is unchanged (Aura's monthly view and points).

## 3. Available features

- Clock-in / clock-out at three kinds of place: company, a customer visit of today, an approved
  work location (each with its own geofence).
- Live-camera selfie (`getUserMedia`, not the gallery), shrunk to a small JPEG in the browser
  (no EXIF location), checked on the server by its bytes, kept private.
- Server timestamp only; the browser sends no time (any `at` / `createdAt` sent is ignored).
- Location with accuracy; flags: outside the geofence, no location, low accuracy; late arrival and
  early leave from the working hours in Settings.
- One clock-in and one clock-out per person per day (a repeated press returns the first).
- Configurable company radius, customer-site radius and worst accepted accuracy; optional "photo
  required" switch that also turns the quick buttons into links to the clock page.
- Daily / range report with present, absent, late, early, missing clock-out, flagged, worked
  minutes; review of flagged days (append-only).
- Notifications to Admins for flagged clock-ins, late arrival and early leave.

## 4. Roles and permissions

| Permission | Who | Allows |
|---|---|---|
| `checkins.record` | Technician (and Admin) | Clock in / out, visit check-ins |
| `car.checkin` | Driver | Clock in / out (car day) |
| `attendance.view` | Admin, Accountant | Everyone's attendance and photos |
| `attendance.manage` | Admin | Review flagged days; work locations and geofences |
| `settings.manage` | Admin | Radii, accuracy limit, photo requirement, working hours |

A person sees their own photos; attendance viewers see everyone's; nobody else (404).

## 5. Business rules

- Clock-out needs a clock-in the same day; a second clock-in or clock-out that day returns the
  first record (`duplicate: true`).
- Customer-site clock-in needs a visit of today assigned to the person; its geofence is around the
  visit's pin (default 300 m). Company default 400 m. Work locations 25–5,000 m.
- Late = clock-in after work start + company grace minutes; the minutes are counted from the work
  start. Early = clock-out before work end.
- Missing clock-out = a past day with a clock-in and no clock-out (today: two hours after the end
  of the working day).
- Absent = a working day without a clock-in or leave.
- Nothing is corrected or guessed: a reading is stored as received with its accuracy; flags go to
  a manager.
- Check-ins are append-only (existing trigger); a review is a separate append-only row.
- The existing visit-stage check-ins (on my way, arrived, start, done…) are unchanged; a clock-in
  related to a visit records `relatedAppointmentId` (the visit-stage constraint is untouched).

## 6. Database models and relationships

Migrations `20261105120000_attendance_geofence_selfie`, `20261105120100_check_in_related_visit`.

| Model / table | Notes |
|---|---|
| `CheckIn` / `check_ins` (existing) | New nullable columns: `site`, `workLocationId`, `selfieKey`, `selfieContentType`, `selfieSha256`, `geofenceM`, `expectedLatitude`, `expectedLongitude`, `relatedAppointmentId`. Existing rows keep NULL. |
| `WorkLocation` / `work_locations` | name, nameAr, latitude, longitude, radiusM, isActive, createdBy. Never deleted (trigger). |
| `AttendanceReview` / `attendance_reviews` | checkInId, decision (`ACCEPTED` / `REJECTED`), note, reviewedBy, time. Append-only. |
| Settings | `companyRadiusM` (400), `customerRadiusM` (300), `maxAccuracyM` (150), `attendanceSelfieRequired` (false). |

## 7. API routes

| Route | Method | Purpose |
|---|---|---|
| `/api/attendance/clock` | GET, POST | Today's state for the clock page; clock in / out |
| `/api/attendance/selfie/[id]` | GET | The photo (permission-checked, private cache) |
| `/api/attendance/review/[id]` | POST | `{ decision, note }` |
| `/api/attendance/work-locations`, `/[id]` | GET, POST / PATCH | Work locations |
| `/api/attendance/report?from&to` | GET | CSV |
| `/api/check-ins`, `/api/check-ins/position` | POST | Existing visit-stage check-ins and live position |

## 8. Services and important logic

- `src/server/services/attendance.ts`: `canClock`, `clockState`, `clock` (transaction with the
  day's uniqueness; selfie saved before the row, removed again if the row is refused), `readSelfie`,
  `reviewCheckIn`, `attendanceRange` (the single reading of days used by the daily page, the
  report and the penalty scan).
- `src/server/services/field.ts`: `insertCheckIn` (distance, flags, late/early, notifications),
  `recordCheckIn` (refuses company/leave quick check-ins when a photo is required), live board,
  late alerts, monthly attendance and points.
- UI: `src/components/attendance/live-camera.tsx`, `clock-panel.tsx`, `review-button.tsx`,
  `work-locations.tsx`; pages `src/app/(app)/attendance/clock` and `/daily`.
- `next.config.ts`: `Permissions-Policy: camera=(self), geolocation=(self)`.

## 9. Validation rules

Action `IN`/`OUT`; site one of the three; visit / work location required for those sites; photo
required, JPEG/PNG/WebP by its bytes, at most 2 MB; note ≤ 300 characters; geo latitude/longitude in
range, accuracy ≥ 0. Work location: name, coordinates, radius 25–5,000. Review: decision, note
required to reject.

## 10. Error handling

422 with field messages (missing photo, fake photo, no visit today, clock-out before clock-in,
photo required); 403 for people who do not clock in; 404 for other people's photos. The browser
shows camera states (starting, denied, unavailable with *Try the camera again*) and location
states (locating, accuracy, denied, unavailable); a missing location is still recorded and flagged.

## 11. Tests

- `tests/integration/attendance.test.ts` (7): server time only, distance and photo; flags and Admin
  notifications; configurable radius and late/early; refusals (no clock-in, missing/fake photo, no
  right); customer site and work location geofences; photo requirement disables the quick buttons;
  daily report with review.
- `tests/integration/field.test.ts`: existing check-in, live board, late alerts, monthly points.
- `e2e/attendance.spec.ts`: Chromium fake camera and simulated location: accuracy shown, photo
  taken, clocked in, Admin sees the day with the photo, photo refused to anonymous requests.

## 12. Current limitations

- A browser cannot prove a location or photo is genuine (mock-location apps exist); the system
  flags and lets a manager review rather than claiming proof.
- No face matching between the photo and the person.
- No background tracking; positions are recorded only when the app sends them.
- The photo is kept as long as the check-in (no automatic retention period).

## 13. Future improvements

- A native wrapper with device integrity checks; face verification on request.
- Shift schedules per person instead of company-wide working hours.
- A retention policy for attendance photos.
