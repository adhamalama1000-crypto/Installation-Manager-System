# GPS tracking

## 1. Module purpose

Use the phone's location, with the person's permission, to know where field staff are at each
stage of their day (at the company, on the way, arrived, started, done), flag readings that are
far from where they should be, estimate arrival times, and show managers a live board. This module
existed before the upgrade (Aura's check-in and live features); the upgrade added configurable
geofences, accuracy limits and attendance places (see `ATTENDANCE.md`).

## 2. How users operate it

- **Technician, visit page → Check-in panel:** *Called the customer, site ready* → *On my way*
  (an estimated arrival is computed) → *Arrived at the customer* → *Start job* / *Done* (from the
  visit outcome). Each press sends the current location with its accuracy.
- **Technician, dashboard → My day:** company arrival and leaving (or the clock page when a photo
  is required).
- **Admin / office screen → Live board (`/board`):** one card per technician, worst first: state
  (not yet, at the company, on the way with ETA, at the customer, problem, finished, on leave),
  since when, the current and next visit, colour (green / yellow / red) by lateness.
- **Driver → Car route (`/route`):** the car's visits in order with check-ins.

## 3. Available features

- Browser Geolocation API only; no location is ever invented. Without a location the check-in is
  recorded and shown as "no location".
- Distance to the company or to the visit's pin; flags: far / outside the geofence, low accuracy.
- Configurable radii (company 400 m, customer 300 m by default), accuracy limit (150 m), approved
  work locations with their own radius.
- Estimated arrival from the last fresh position (≤ 30 minutes old) and a speed model by hour.
- Live board; late alerts once a day per item through a secret-protected endpoint
  (`/api/cron/late-check`); monthly attendance and points.

## 4. Roles and permissions

`checkins.record` (technicians), `car.checkin` (driver), `board.view` (Admin and office screen
viewers), `route.view` (driver), `attendance.view` / `attendance.manage` (managers). Locations of
other people are never sent to technicians.

## 5. Business rules

- Locations are stored as received (latitude, longitude, accuracy, distance); they are never
  corrected.
- A visit's arrival far from the pin is flagged, not refused; the manager reviews it.
- Positions older than 30 minutes are not used for ETA.
- Check-ins are append-only (database trigger).

## 6. Database models and relationships

`check_ins` (user, kind, day, visit, latitude, longitude, accuracyM, distanceM, far flag,
lateMinutes, earlyMinutes, and since the upgrade site, workLocationId, geofenceM, expected position,
selfie), `technician_positions` (latest position per technician), `work_locations`,
`alerts_sent` (late alerts already sent).

## 7. API routes

`POST /api/check-ins` (stage check-in), `POST /api/check-ins/position` (position update),
`POST /api/route/check-ins`, `/api/route/order`, `/api/route/warn` (car), `GET /api/cron/late-check`
(secret header), `/api/attendance/*` (see `ATTENDANCE.md`).

## 8. Services and important logic

`src/server/services/field.ts` (`insertCheckIn`, `recordCheckIn`, `recordPosition`, `liveBoard`,
`lateItems`, `runLateCheck`, `attendance`), `src/server/services/car.ts`, `src/lib/field.ts`
(distance, ETA), `src/lib/geo-client.ts` (`currentPosition` with timeout and error kinds).

## 9. Validation rules

Latitude −90…90, longitude −180…180, accuracy ≥ 0; check-in kind valid for the user's role and the
visit's state (e.g. arrival needs "on my way" first).

## 10. Error handling

Permission denied or no position → recorded without coordinates and shown as such; invalid
sequence → 422 with the reason (for example "Call the customer first…", or leaving the company
before arriving there); no right → 403.

## 11. Tests

`tests/integration/field.test.ts` (flags, sequence, ETA, board, late alerts, monthly points),
`tests/integration/attendance.test.ts` (geofences, accuracy), `e2e/field.spec.ts` (company and visit
check-ins with a simulated location; the Admin sees the arrival on the live board),
`e2e/attendance.spec.ts`.

## 12. Current limitations

A web app cannot track in the background or detect mock locations; accuracy depends on the phone.
ETA uses straight-line distance and an hourly speed model, not a routing service.

## 13. Future improvements

Routing-based ETA, a native app for background tracking with consent, map view of the live board.
