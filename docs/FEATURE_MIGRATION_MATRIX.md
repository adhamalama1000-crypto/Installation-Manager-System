# Feature migration matrix

Every feature found in the legacy Apps Script code (`Code.gs`, `Index.html`) compared with the
modern application, with the migration decision. Legacy behaviour was read from the source; the
function names are given so each row can be checked. This file supersedes the earlier
`AURA-FEATURE-MATRIX.md` (kept for history).

**Modern status before this work:** ✅ present · ◐ partial · ✗ missing · ⚠ different on purpose.
**Decision:** *Keep* (already equivalent) · *Migrate* (implement in the modern app) · *Adapt*
(implement the intent with a safer design) · *No* (not ported, reason given).
The final implementation status of each row is in `IMPLEMENTATION_STATUS.md`.

## Booking and scheduling

| Legacy feature (source) | Modern before | Decision | Notes |
|---|:-:|---|---|
| Orders with client, phones, area, address, map link (`api_save`) | ✅ | Keep | Customers + several sites per customer |
| Order number `YYMM-NNN` (`nextId_`) | ⚠ | No | `APT-000123` stays; imported orders keep their legacy number in `legacyRef` |
| Periods 11:30/14:30/17:30, two-period, whole day, after hours (`PERIODS`) | ⚠ | Adapt | Exact start + duration is a superset; the importer maps period codes to times |
| Conflict check per engineer and slot (`conflictsFor_`, `busyMap_`) | ✅ | Keep | Advisory lock + exclusion constraint is stronger |
| Managers "book anyway" over a conflict (`o.force`) | ⚠ | No | Would break the no-double-booking guarantee |
| Friday closed (`weekday_ === 5`) | ✅ | Keep | Configurable closed weekdays, Admin override |
| Saturday: smart-home inspections only (warning, `alerts_`) | ✗ | No | Company convention, only a warning in legacy |
| Phone = 11 digits starting 01 | ⚠ | No | Would reject numbers already accepted (landlines, foreign) |
| No booking in the past except managers (`api_save`) | ✗ | Migrate | Admin may still record a past visit |
| 10-minute slot hold while Sales is on the phone (`api_hold`, `heldBy_`, `releaseHolds_`) | ✗ | Migrate | Stored in PostgreSQL with expiry, same lock as bookings; expired holds never block |
| Visit kinds (inspection/installation/completion/programming/maintenance) | ✅ | Keep | |
| Customer confirmation + "confirm today/tomorrow" alert | ✅ | Keep | |
| Site readiness: wiring/foundation and internet status (`foundation`, `internet`, alert in `alerts_`) | ✗ | Migrate | Two enums on the booking + dashboard alert for smart-home visits |
| Where the lock/devices are (office / client / undecided) (`lockWhere`) | ✗ | Migrate | Shown in the day plan ("take it from the office") |
| Door type, count, devices list, electrician, size (`door`, `count`, `devices`, `electrician`, `size`) | ◐ | Adapt | Kept as free text in "required equipment"/"description"; the importer maps them there |
| Follow-up visit linked to the original (`followOf`) | ✅ | Keep | |
| Missing-data / overdue / conflict alerts (`alerts_`) | ✅ | Keep | Dashboard "needs attention" |
| Change log (`DB_Log`) | ✅ | Keep | Append-only audit log |
| Client history by phone (`api_clientLookup`) | ✅ | Keep | |
| Technician specialty (lock / smart / both) and "best technician" suggestion (`api_free` score) | ✗ | Migrate | Specialty on the user; availability marks a mismatch and orders free technicians by fit and day load |

## Field work

| Legacy feature | Modern before | Decision | Notes |
|---|:-:|---|---|
| Technician sees own visits only | ✅ | Keep | |
| Done / needs another visit with mandatory report | ✅ | Keep | |
| Attendance check-in at the office / check-out (`api_checkin` `company`/`leave`) with lateness and early-leave flags (`WORK`) | ✗ | Migrate | Configurable work start/grace/end; optional GPS; distance from the company location |
| Visit stages: picked up, called the client, departed, arrived, started, problem (`STAGES`) | ✗ | Migrate | Optional GPS and distance-from-site flag; "departed" requires "called the client" like legacy |
| Problem reasons; client-fault problem adds the repeat-visit fee (`CLIENT_FAULT`, `REVISIT_FEE`) | ✗ | Migrate | Setting `revisitFee`; fee applied once, audited |
| Live position ping and ETA (`api_ping`, `etaMin_`) | ✗ | Adapt | ETA estimate from the departure position; no continuous tracking (privacy) |
| Live board of every technician today (`api_live`, `api_tracking`) | ✗ | Migrate | "Field board" page for managers |
| Office TV screen via secret link without login (`api_screenLogin`) | ✗ | No | Unauthenticated access to customer data; use a Viewer account on the TV instead |
| Late alerts every 15 min; 9:00 e-mail summary (`lateCheck`, `morningReport`) | ✗ | Adapt | Late items computed on the field board and sent as in-app notifications by `/api/cron/late-check` (secret-protected, for an external scheduler); no e-mail provider |
| Day plan: one WhatsApp per technician (`waText`) | ✅ (English) | Migrate | Arabic and English templates |
| Customer "prepare the site" message the day before (`prepText`) | ◐ | Migrate | Reminder includes category-specific preparation lines, Arabic and English |
| Delivery checklist per product kind (`CHECKLIST`, `deliveryMissing_`) | ✗ | Migrate | Editable lists in Settings; completion rule configurable |
| Before/after photos, client site photo (`api_uploadPhoto`, `readyPhoto`) | ✗ | Migrate | Private file storage served through an authorised route (never public links) |
| Customer signature on the phone (`sigpad`, `api_uploadFile` `sign`) | ✗ | Migrate | Canvas → PNG attachment |
| Payment transfer screenshot (`payPhoto`) and deposit proof (`api_depositPhoto`) | ✗ | Migrate | Attachments of kind PAYMENT_PROOF / DEPOSIT_PROOF |
| Serial required on install (`SERIAL_REQUIRED`) | ✗ | Migrate | Setting |
| Company car: driver role, "by car" flag, ordered route, manual reorder, driver stages, route warnings (`api_route`, `api_carCheckin`, `api_routeOrder`, `api_carWarn`) | ✗ | Migrate | Vehicles table (legacy had one car), DRIVER role, route page |
| Leave / sick / absence with approval (`api_leave*`) | ✅ | Keep | |

## Money

| Legacy feature | Modern before | Decision | Notes |
|---|:-:|---|---|
| Total, deposit (+method), remaining, collected (+method), extra fee | ✅ | Keep | Derived amounts moved to integer minor units |
| Cash custody until the accountant receives it (`DB_Cash`, `api_cashReceive`) | ✅ | Keep | |
| Monthly statement (`api_statement`) | ◐ | Migrate | Adds transport expenses and attendance like legacy |
| Statement export to Excel (`api_exportStatement`) | ◐ | Adapt | CSV exports (statement summary + per visit + expenses + attendance) |
| Technician transport expenses with receipt, paid by the accountant (`api_expenseAdd`, `api_expensePay`) | ✗ | Migrate | Categories (transport default), receipt attachment, pay / reject, audited, in the statement |
| Quotation link parsed into items; prices hidden from technicians (`api_quote`, `parseQuote_`) | ✗ | Adapt | Server fetch only from an allow-listed host (setting), size/time limits, snapshot stored on the booking |

## Inventory and after-sales

| Legacy feature | Modern before | Decision | Notes |
|---|:-:|---|---|
| Serial stock, custody, installed, returned, faulty | ✅ | Keep | |
| Warranty months per model, warranty end per order | ✅ | Keep | |
| Complaints: open on an order with warranty status, assign, link maintenance visit, resolve, close, reopen, auto-resolve when the visit is done (`api_complaint*`, `resolveComplaints_`) | ✗ | Migrate | Adds priority (requested), numbering `CMP-000001`, history |
| Client satisfaction rating 1–5 + note (`rating`, `ratingNote`) | ✗ | Migrate | Dashboard "satisfaction calls due" (3–14 days after the visit) |
| Head's quality grade 1–5 (`qGrade`) | ✗ | Migrate | Dashboard "grade the work" for finished visits with photos |
| Maintenance reminders 6 / 12 months after install (`maintDue_`, `maintNote`) | ✗ | Migrate | Dashboard list + "mark followed up" |
| Monthly points per technician (`api_stats`, `api_myPoints`) | ✗ | Migrate | Weights configurable, legacy defaults |

## Platform and administration

| Legacy feature | Modern before | Decision | Notes |
|---|:-:|---|---|
| PIN login | ⚠ | No | Password login is stronger |
| 10 roles | ◐ | Adapt | heads/supervisor → Admin; engineer/tech → Technician; new DRIVER role for the car |
| Arabic UI, RTL | ✗ | Migrate | Full Arabic + English with a language switch (whole product) |
| Editable lists (areas, types, doors, devices) | ◐ | No | Free text with existing customer data; product models stay managed |
| In-app notifications | ✅ | Keep | Rendered in the reader's language |
| Monthly statistics incl. by area and visit durations (`api_stats`) | ◐ | Migrate | Report by area; visit duration from arrive → done check-ins in the performance report |
| Google Sheet sync / sheet lock / re-import (`syncSheet_`, `lockSheet_`) | — | No | PostgreSQL is the single store |
| Import of legacy orders (`importOrders_`, `LEGACY_ORDERS`) | ✗ | Adapt | `scripts/import-legacy.ts`: idempotent import of a `DB_Orders` CSV/JSON export, dry run by default; the real data in `Legacy.gs` is not committed |
| Company location (`api_setCompany`) | ✗ | Migrate | Setting (used for attendance distance and the route start) |
| Area centre coordinates for distance estimates (`AREA_GEO`) | ✗ | Migrate | Fallback for route ordering when a site has no coordinates |
