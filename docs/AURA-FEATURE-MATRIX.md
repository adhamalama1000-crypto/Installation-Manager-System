# Aura (Google Apps Script) vs. Installation Manager System: feature matrix

Source compared: `aura-source.zip` (`src/Code.gs` 2,591 lines, `src/Index.html`, `src/Legacy.gs`,
setup notes). Aura is a Google Apps Script web app that stores everything in a Google Sheet (one tab
per table), logs in with 6-digit PINs and runs as the sheet owner. This app replaces it; nothing here
moves the app to Apps Script.

**Status:** ✅ implemented · ◐ partial · ✗ missing · ⚠ conflicting (different design on purpose).
**Plan:** **Now** = integrated in this round (see the end) · Later = worth doing next · No = not
porting (reason given).

## Booking and orders

| Aura feature | This app | Status | Plan |
|---|---|:-:|---|
| Order with client, phone, area, address, Google Maps link | Customer + saved sites, map link, coordinates, apartment/floor, access notes | ✅ | — |
| Order number `YYMM-NNN` | Sequential `APT-000123` | ⚠ | No: changing IDs would break existing links; an imported Aura number can be kept in the notes |
| Fixed day periods (11:30–1:30, 2:30–4:30, 5:30–7:30, "two periods", "whole day", "after hours") | Exact start time + duration (any slot), presets for durations | ⚠ | No: exact times are a superset; periods are just start/duration presets |
| Double-booking prevention per technician | Server check + PostgreSQL exclusion constraint (concurrency-safe) | ✅ | — |
| Admin "book anyway" over a conflict | Not possible (the database forbids overlaps) | ⚠ | No: would break the no-double-booking guarantee |
| Friday closed (booking refused, alert) | Configurable closed weekdays (Settings); only an Admin can book one, explicitly | ✅ | Done |
| Saturday: smart-home inspections only | — | ✗ | No: company-specific rule; can be a status/type convention |
| Phone must be an Egyptian mobile (11 digits, `01…`) | 7–15 digits, international formats allowed | ⚠ | No: stricter rule would reject landlines and foreign numbers already accepted |
| No booking in the past (except managers) | Allowed for everyone who can book | ✗ | Later |
| Order types: install / maintenance / programming / inspection / completion, for lock and smart home | Product category + visit type (inspection, installation, completion, programming, maintenance) | ✅ | Done |
| Customer confirmation (awaiting / confirmed / wants another time / unreachable) and "confirm with the client" alert for today and tomorrow | Confirmation on every booking, changed from the details page; dashboard alert for today and tomorrow | ✅ | Done |
| Site readiness (wiring, internet) for smart home | Free-text notes | ◐ | Later |
| Door type, quantity, devices list, "where is the lock" (office / client), electrician needed, size | Brand, model, description, required equipment (free text) | ◐ | Later: structured fields only if reports need them |
| Status set: confirmed, done, postponed, needs another visit, cancelled | Configurable statuses with kinds, now including "needs another visit" | ✅ | Done |
| Follow-up visit linked to the original order | "Follow-up visit" pre-fills a new booking linked both ways; dashboard asks for one after "needs another visit" | ✅ | Done |
| Missing-data and overdue alerts | Dashboard "Needs attention" (overdue status, no technician, technician on leave, no map location, unconfirmed, no follow-up booked) | ✅ | Done |
| Change log of every booking / edit | Field-level history + append-only audit log | ✅ | — |
| Client history by phone | Customer directory + repeat-customer lookup while booking | ✅ | — |

## Field work (technicians)

| Aura feature | This app | Status | Plan |
|---|---|:-:|---|
| Technician sees only own visits | Same, enforced on the server | ✅ | — |
| Technician marks "done" / "needs another visit" with a **mandatory visit report** | Assigned technician starts the job and records done / unable / needs another visit with a required report; Sales notified | ✅ | Done (booking details stay read-only for technicians) |
| Before/after photos, client signature, transfer screenshot (Google Drive) | No file attachments | ✗ | Later: needs file storage (S3-compatible or disk) |
| Delivery checklist that must be complete before "done" | — | ✗ | Later (with photos) |
| Check-in stages with GPS (at office, picked up, left, arrived, started, done, problem) and distance flags | — | ✗ | Later: location tracking needs consent and a privacy policy |
| Live board of where every technician is, office TV screen link | Calendar + dashboard | ✗ | Later (needs check-ins) |
| Late alerts every 15 minutes, morning e-mail summary | In-app notifications only; no e-mail provider | ✗ | Later (needs an e-mail/WhatsApp provider) |
| Day plan: one WhatsApp message per technician with tomorrow's visits | — | ✗ | **Now** (message text + `wa.me` link; nothing is sent automatically) |
| Technician specialty (lock / smart home / both) and best-technician suggestion | Live available/busy list | ◐ | Later |
| Temporary 10-minute hold of a slot while on the phone | — | ✗ | Later |
| Company car / driver route with stops | — | ✗ | Later |
| Attendance, lateness and monthly points from check-ins | — | ✗ | Later (needs check-ins) |
| Leave / sick / absence requests, approval, blocks booking, warns about existing bookings | Technicians ask, Admins approve/reject or record; approved leave refuses bookings and shows "On leave" in the form; existing bookings listed, their Sales creators notified, dashboard alert | ✅ | Done |

## Money

| Aura feature | This app | Status | Plan |
|---|---|:-:|---|
| Total, deposit (+ method, proof), remaining, collected at the visit (+ method), extra fee for a repeat visit caused by the client | Price, deposit + method, extra fee on the booking; the technician records what was collected (+ method) with the outcome and only sees the amount to collect | ◐ | Done except transfer proofs/photos (need file storage → Later); the repeat-visit fee is entered by Sales, not set automatically |
| Cash custody: cash with each technician until the accountant receives it | Cash collections are held by the technician until the Accountant/Admin confirms receipt (all, or chosen visits); corrections allowed only before hand-over; audited and notified | ✅ | Done |
| Monthly statement: sales, deposits and collections by method, balances owed per client, cash held | Finance page per month (booked value, deposits and collections by method, extra fees, customers who still owe, cash held) + per-visit finance CSV | ✅ | Done (transport expenses and attendance are not part of it yet) |
| Technician transport expenses with receipts, paid by the accountant | — | ✗ | Later |
| Quotation link from the company website parsed into items and prices (prices hidden from technicians) | — | ✗ | Later: fetching arbitrary URLs from the server needs an allow-list |

## Inventory and after-sales

| Aura feature | This app | Status | Plan |
|---|---|:-:|---|
| Serial-number stock: goods in, custody to a technician, installed on an order, returned, faulty; optional "serial required" on install | Inventory page: goods in by serial, hand to / take back from technicians, returned / faulty, append-only history per serial; technicians install from their own custody when finishing a visit | ✅ | Done; serials are optional on install (no "serial required" setting yet) |
| Warranty per model (months) and warranty end date per order | Warranty months per model; each installed serial gets an end date from the visit date, shown on the appointment | ✅ | Done |
| Complaints: open on an order, warranty status, assign to a technician, link the maintenance visit, resolve, close | — | ✗ | Later |
| Client satisfaction rating and head-of-installations quality grade | — | ✗ | Later |
| Maintenance reminders 6 / 12 months after an install | — | ✗ | Later |

## Platform and administration

| Aura feature | This app | Status | Plan |
|---|---|:-:|---|
| 6-digit PIN login, sessions in the script cache | E-mail + password (bcrypt), server sessions, rate limiting, invitation links | ⚠ | No: PINs are weaker; keep the current login |
| 10 roles (admin, head of installations, head of sales, supervisor, sales, engineer, technician, driver, store, accountant) | Admin, Sales, Technician, Accountant, Store keeper, Viewer (+ per-viewer permissions) | ◐ | Accountant and Store keeper added; heads = Admin, driver/engineer not needed yet |
| Editable lists (engineers, sales, areas, order types, doors, devices, models) | Users, statuses and product models (with warranty months) are managed; categories fixed | ◐ | Areas/doors/devices lists: Later |
| In-app notifications | Notifications for technicians, Sales (visit outcome, leave clashes) and Admins (leave requests) | ✅ | Done |
| Monthly statistics (by sales, engineer, type, area; ratings; visit durations) | Reports by status, Sales, category, technician workload, per day | ◐ | Later: by area |
| Month export to Excel | CSV exports | ✅ | — |
| Google Sheet sync, sheet lock, re-import from month tabs | PostgreSQL is the only store | — | No: Google-Sheets-specific |
| Legacy December/January orders embedded in `Legacy.gs` (real customer data) | — | — | No automatic import: real personal data; a one-off importer can be written once you decide what to migrate |

## Integrated in this round

1. Booking: visit type, customer confirmation (+ dashboard alert), closed weekdays, follow-up visits.
2. Technician outcome: done / unable to complete / needs another visit with a mandatory report;
   Sales and Admin are notified.
3. Technician leave: requests, approval, booking blocked on leave days, conflicts flagged.
4. Payments: price, deposit, collection by the technician, extra fee; cash custody and accountant
   receipt; monthly finance report and CSV.
5. Inventory: product models with warranty, serial stock with custody and history, serials
   installed on an appointment with warranty end date.
6. Day plan with WhatsApp links.

Every new action is permission-checked on the server and audited, every schema change is an
additive migration, and the new screens use the same query patterns as the rest of the app.
