# Feature migration matrix: Aura (Google Apps Script) → Installation Manager System

## Sources compared

The legacy source was re-audited function by function on 2026-10-31:
- **`src/Code.gs`:** 2,591 lines, 190 functions, including the 87 `api_*` entry points the UI calls.
- **`src/Index.html`:** the single-page UI and every `api_*` call it makes.
- **`src/Legacy.gs`:** real customer orders from December and January. These are not imported.
- **`اقرأني_التشغيل.md`:** the setup notes.

The modern side was compared from the actual code on the `claude/aura-delivery-proof` branch: the Prisma schema, services, API routes and pages.

## How Aura works

Aura stores everything in a Google Sheet, one tab per table:
- `DB_Orders`, `DB_Users`, `DB_Lists`, `DB_Log`
- `DB_Checkins`, `DB_Stock`, `DB_Cash`, `DB_Complaints`
- `DB_Notif`, `DB_Leaves`, `DB_Expenses`

Users log in with 6-digit PINs, and the script runs as the sheet owner. This application replaces Aura with Next.js and PostgreSQL. Nothing is moved to Apps Script.

## Legend

**Status**
- ✅ implemented and verified (tests on the default branch, or on an open PR marked as such)
- ◐ partial
- 🚧 in progress on a branch
- ✗ missing
- ⚠ different design on purpose

**Phase:** where the remaining work is planned. The phases are listed at the end. **No** means the feature is not being ported, and the reason is given.

---

## 1. Booking and orders

| Aura feature (function) | This app today | Status | Phase |
|---|---|:-:|:-:|
| Order with client, phone, area, address, Maps link (`api_save`) | Customer, saved sites, map link and coordinates, apartment and floor, access notes | ✅ | — |
| Order number `YYMM-NNN` (`nextId_`) | Sequential `APT-000123` | ⚠ | No: changing IDs breaks existing links. An imported Aura number can go in the notes. |
| Fixed day periods: 11:30–1:30, 2:30–4:30, 5:30–7:30, two periods, whole day, after hours (`PERIODS`) | Exact start time and duration, with duration presets | ⚠ | No: exact times cover every period |
| Double-booking prevention (`busyMap_`, `conflictsFor_`) | Server check plus a PostgreSQL exclusion constraint, safe under concurrency | ✅ | — |
| Admin "book anyway" over a conflict | Not possible | ⚠ | No: it would break the no-double-booking guarantee |
| Friday closed (`alerts_`) | Configurable closed weekdays; only an Admin can book one, explicitly | ✅ | — |
| Saturday: smart-home inspections only (`alerts_`) | — | ✗ | E: configurable "inspection-only weekdays" warning |
| No booking in the past, except managers (`api_save`) | Anyone who can book may pick a past date | ✗ | E |
| Phone must be an Egyptian mobile (`api_save`) | 7–15 digits, international formats allowed | ⚠ | No: a stricter rule would reject numbers already stored |
| Order kind: inspection, installation, completion, programming, maintenance × lock / smart home (`VISIT_KIND`) | Product category and visit type | ✅ | — |
| Customer confirmation, plus a "confirm with the client" alert for today and tomorrow | Confirmation on every booking; dashboard alert | ✅ | — |
| Site readiness for smart home: foundation and internet, with a "check readiness" alert (`alerts_`) | Free-text notes only | ◐ | E: structured fields and an alert |
| Where the lock is (company / client / not decided), electrician needed, door type, quantity, devices, size (`lockWhere`, `electrician`, `door`, `count`, `devices`, `size`) | Brand, model, description, required equipment (free text) | ◐ | E: `lockWhere` and `electrician` as structured fields, since check-ins and the live board use them; the rest stays free text |
| Status set: confirmed, done, postponed, needs another visit, cancelled | Configurable statuses with kinds, Arabic names | ✅ | — |
| Follow-up visit linked to the original (`followOf`) | Linked both ways; dashboard asks for one | ✅ | — |
| Missing-data, overdue and postponed alerts (`alerts_`, `missing_`) | Dashboard "Needs attention" | ✅ | — |
| Change log (`log_`, `diff_`) | Field-level history plus an append-only audit log | ✅ | — |
| Client history by phone while booking (`api_clientLookup`) | Repeat-customer lookup while booking | ✅ | — |
| Quotation link from aura.eg parsed into items, totals and Sales person; prices hidden from technicians (`api_quote`, `parseQuote_`, `noPrices_`) | — | ✗ | E: server fetch limited to an allow-listed host, with a size and time limit; technicians see items without prices |
| Temporary 10-minute hold on a slot while on the phone (`api_hold`, `HOLD_MIN`) | — | ✗ | E |
| Best-technician suggestion by specialty, load and distance (`api_free`, `specFits_`) | Live available/busy list in the booking form | ◐ | E: specialty per technician and a ranked suggestion |
| Car warning at booking: more than 3 drops in a period, or drops 20 km or more apart (`api_carWarn`) | — | ✗ | D |

## 2. Field work: technicians

| Aura feature (function) | This app today | Status | Phase |
|---|---|:-:|:-:|
| Technician sees only their own visits | Enforced on the server | ✅ | — |
| Mark done / needs another visit with a mandatory report | Start the job; done / unable / needs another visit with a required report; Sales notified | ✅ | — |
| Problem reasons list, with client-fault reasons (`PROBLEMS`, `CLIENT_FAULT`) | Free-text report | ✗ | C: a reason list on the outcome and the "problem" check-in |
| Repeat-visit fee set automatically on a client-fault problem (`REVISIT_FEE`, `api_setFee`) | The extra fee is typed by Sales | ◐ | C: an Admin-set fee, applied on a client-fault "needs another visit" |
| Before photos from Sales, after photos from the technician, up to 20 per order (`api_uploadPhoto`, `api_deletePhoto`) | — | 🚧 | A |
| Customer signature (`api_uploadFile` sign) | — | 🚧 | A |
| Transfer screenshot for a non-cash collection (`api_uploadFile` pay) | — | 🚧 | A |
| Deposit proof photo (`api_depositPhoto`) | — | 🚧 | A |
| Delivery checklist, lock or smart, required before "done" on installation and completion (`CHECKLIST`, `deliveryMissing_`) | — | 🚧 | A: behind an Admin setting, off by default to keep current behaviour |
| "Serial required" before "done" (`api_setSerialRequired`) | Serials optional | 🚧 | A: Admin setting |
| GPS check-in stages: company, pickup, ready (photo), depart, arrive, start, done, problem, leave (`api_checkin`, `checkin_`) | — | ✗ | C: browser geolocation with the user's consent; nothing is faked when location is denied |
| Distance flags: more than 400 m from the company, more than 300 m from the client (`checkin_`) | — | ✗ | C |
| ETA on "depart": distance × 1.4 ÷ speed by time of day, plus 5 min (`etaMin_`) | — | ✗ | C |
| Live position pings (`api_ping`) | — | ✗ | C: the latest position only, while a visit is open; no history beyond check-ins |
| Live board of every technician: free, not yet, at company, at client, finished (`api_tracking`, `api_live`) | Calendar and dashboard | ✗ | C |
| Office TV screen link, token login (`api_screenLogin`, `api_screenReset`) | — | ⚠ | C: the board refreshes itself; on the office screen it runs under a Viewer account rather than a shared token URL |
| Sales notified on depart, arrive and problem; heads on late arrival or early leave (`notifyStage_`) | In-app notifications exist | ✗ | C |
| Late alerts every 15 minutes (`lateCheck`, `lateItems_`) | — | ✗ | C: a protected endpoint for a scheduler (Windows Task Scheduler, cron), sending in-app notifications |
| Morning e-mail summary (`morningReport`, `alertEmail_`) | — | ✗ | Blocked: no e-mail provider is configured. The summary page is built in C; sending needs SMTP settings. |
| Attendance per month: days, late, minutes late, left early, leave/sick/absence days, absent on a visit day (`attendance_`, `api_attendance`, `api_myAttendance`) | Leave records only | ✗ | C |
| Monthly points: punctuality 40, rating 30, quality 20, visits 10, minus revisits, complaints, late days and absences (`api_stats`, `api_myPoints`) | — | ✗ | C, after B (ratings, quality and complaints feed the score) |
| Day plan: one WhatsApp message per technician (`api_dayPlan`) | Day plan page, Arabic or English | ✅ | — |
| Technician specialty: lock / smart home / both (`spec`) | — | ✗ | E |
| Leave, sick and absence requests that block booking (`api_leave*`) | Requests, approval, booking block, clash alerts | ✅ | — |

## 3. Money

| Aura feature (function) | This app today | Status | Phase |
|---|---|:-:|:-:|
| Total, deposit and method, remaining, collected and method, extra fee | Price, deposit and method, extra fee; collection recorded with the outcome; technicians see only the amount to collect | ✅ | — |
| Deposit proof, transfer proof | — | 🚧 | A |
| Cash custody until the accountant receives it (`api_cash`, `api_cashReceive`) | Custody until the Accountant or Admin confirms receipt | ✅ | — |
| Monthly statement: sales, deposits and collections by method, owed per client, cash held (`api_statement`) | Finance page and CSV | ✅ | — |
| Statement includes transport expenses and attendance (`api_statement`, `api_exportStatement`) | — | ✗ | D (expenses), C (attendance) |
| Transport expenses with a receipt photo, paid per user per month by the accountant (`api_expenseAdd`, `api_expenses`, `api_expensePay`) | — | ✗ | D |

## 4. Company car

| Aura feature (function) | This app today | Status | Phase |
|---|---|:-:|:-:|
| Driver role (`driver`) | — | ✗ | D |
| Car flag on an order, with a manual stop order (`car`, `carSeq`, `api_routeOrder`) | — | ✗ | D |
| Route per day: manual order, then nearest neighbour per slot from the company (`routeStops_`, `api_route`) | — | ✗ | D |
| Route warnings: more than 3 drops per period, drops 20 km or more apart (`routeWarnings_`) | — | ✗ | D |
| Car check-ins: go, drop, pick up, back (`api_carCheckin`, `CAR_STAGES`) | — | ✗ | D, after C (GPS check-ins) |
| Car on the live board (`carLive_`) | — | ✗ | D |

## 5. Inventory and after-sales

| Aura feature (function) | This app today | Status | Phase |
|---|---|:-:|:-:|
| Serial stock: goods in, custody, installed, returned, faulty (`api_stock*`) | Inventory page with an append-only history | ✅ | — |
| Warranty months per model and warranty end per order (`warrantyFor_`) | Per model; an end date for each installed serial | ✅ | — |
| Complaints: number `CYYMM-NNN`, warranty status, Sales or a manager opens one, a manager assigns it, the technician resolves it, Sales or a manager closes or reopens it, auto-resolved when the linked maintenance visit is done (`api_complaint*`, `resolveComplaints_`) | — | ✗ | B |
| Customer satisfaction rating 1–5 with a note, plus a "call to rate" list for visits done 3–14 days ago (`rating`, `ratingNote`, `api_dashboard`) | — | ✗ | B |
| Head of installations' quality grade, plus a "review quality" list for visits done in the last 30 days with photos (`qGrade`) | — | ✗ | B |
| Maintenance reminders 6 and 12 months after an installation, from 7 days before to 21 days after, marked when called (`maintDue_`, `maintNote`) | — | ✗ | B |

## 6. Reports and dashboard

| Aura feature (function) | This app today | Status | Phase |
|---|---|:-:|:-:|
| Dashboard counters: today, tomorrow, week, conflicts, missing, overdue, no engineer, by Sales | Dashboard counters and "Needs attention" | ✅ | — |
| Dashboard: complaints open, satisfaction calls, quality reviews, maintenance due | — | ✗ | B |
| Dashboard: pending expenses, pending leave requests, cash held | Leave and cash: yes; expenses: no | ◐ | D |
| Monthly stats by Sales, engineer, type and area; ratings; visit durations from check-ins (`api_stats`) | Reports by status, Sales, category, technician, day | ◐ | B (ratings), C (durations), E (area) |
| Month export (`api_export`) | CSV exports | ✅ | — |

## 7. Platform and administration

| Aura feature | This app today | Status | Phase |
|---|---|:-:|:-:|
| 6-digit PIN login | E-mail and password (bcrypt), server sessions, rate limiting, invitations | ⚠ | No: PINs are weaker |
| 10 roles: admin, head of installations, head of sales, supervisor, sales, engineer, technician, driver, store, accountant | Admin, Sales, Technician, Accountant, Store keeper, Viewer (with per-viewer permissions) | ◐ | D adds Driver. Heads and supervisor stay Admin; engineer stays Technician. |
| Editable lists: engineers, sales, areas, types, doors, devices, models (`api_adminSaveLists`) | Users, statuses, product models | ◐ | E: an areas list with coordinates (`AREA_GEO`), used for ETA and routes when a site has no pin |
| Company location setting (`api_setCompany`) | — | ✗ | C |
| In-app notifications | Yes, stored as message keys, shown in each reader's language | ✅ | — |
| Arabic interface | Arabic-first RTL with an English switch | ✅ | PR #3 |
| Google Sheet sync, sheet lock, re-import from month tabs (`sync*`, `lockSheet`, `reimportOrders`) | PostgreSQL is the only store | — | No: specific to Google Sheets |
| December/January orders embedded in `Legacy.gs` | — | — | No automatic import: it holds real personal data. A one-off importer can be written once the owner decides what to migrate. |

---

## Phases

Each phase is its own branch and pull request, stacked on the previous one. Each phase has:
- additive, reversible migrations
- Arabic and English text for every screen, message and notification
- server-side permission checks and audit entries
- integration and browser tests

Progress and test results are recorded in [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md).

| Phase | Scope | Depends on |
|---|---|---|
| **A: Delivery proof** | Photos (before and after), customer signature, payment and deposit proofs, delivery checklist, "serial required" and "proof required" settings | PR #3 (i18n) |
| **B: After-sales** | Complaints, satisfaction rating, quality grade, satisfaction and quality lists, maintenance reminders, dashboard counters | A (quality reviews use photos) |
| **C: Field tracking** | Company location and work hours, GPS check-in stages with distance flags and ETA, live board, problem reasons and automatic repeat-visit fee, stage notifications, late-check endpoint, attendance, monthly points | B (points use ratings and complaints) |
| **D: Expenses and car** | Transport expenses with receipts and payment, statement totals, Driver role, car route and warnings, car check-ins | C |
| **E: Booking helpers** | Slot holds, quotation parsing (allow-listed host), specialty and suggestion, no past bookings for non-managers, inspection-only weekdays, site readiness and lock location, areas list | A |

## Blocked or needing configuration

- **E-mail (morning summary, late alerts by e-mail):** no e-mail provider is configured in this project. In-app notifications and the summary page work without one. Sending needs SMTP credentials in the environment.
- **Location:** check-ins use the browser's Geolocation API. They need HTTPS in production (browsers allow geolocation only on secure origins and `localhost`) and the user's permission. When permission is denied, the check-in is recorded without coordinates and flagged; no position is invented.
- **File storage:** uploads are stored on the server's disk (`UPLOAD_DIR`). Back that folder up together with the database.
