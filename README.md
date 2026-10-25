# Installation Manager System

A full-stack web application for scheduling and managing installation appointments (smart locks, smart home, CCTV, intercoms, ...): customers and installation sites, Sales bookings, technician assignment with **server-side double-booking prevention**, a colour-coded company calendar, reports, and a complete audit history.

Built with **Next.js 16 (App Router) · React 19 · TypeScript · Tailwind CSS 4 · Prisma 6 · PostgreSQL**.

| Dashboard | Calendar (week) |
|---|---|
| ![Dashboard](docs/screenshots/dashboard.png) | ![Calendar week view](docs/screenshots/calendar-week.png) |
| **Booking form with live technician availability** | **Dark theme (month view)** |
| ![New appointment](docs/screenshots/new-appointment.png) | ![Calendar month dark](docs/screenshots/calendar-month-dark.png) |

<p align="center"><img src="docs/screenshots/technician-mobile.png" alt="Technician view on a phone" width="260"></p>

---

## Contents

1. [Features](#features)
2. [Quick start (local development)](#quick-start-local-development)
3. [Demo accounts](#demo-accounts)
4. [Roles & permissions](#roles--permissions)
5. [How double-booking is prevented](#how-double-booking-is-prevented)
6. [Dates, times and timezones](#dates-times-and-timezones)
7. [Architecture](#architecture)
8. [Database](#database)
9. [Testing](#testing)
10. [Deployment](#deployment)
11. [Environment variables](#environment-variables)
12. [Branding](#branding)
13. [Notifications - what is and isn't included](#notifications---what-is-and-isnt-included)
14. [Performance](#performance)
15. [Known limitations](#known-limitations)

---

## Features

- **Authentication** with secure server-side sessions (random 256-bit token in an `HttpOnly`, `SameSite=Lax` cookie; only its SHA-256 hash is stored), bcrypt password hashing, database-backed login rate limiting, and one-time invitation / password-reset links.
- **Four roles** - Admin, Sales, Technician, Viewer - enforced on the server for every query and API call. Viewers get per-account permissions chosen by an Admin.
- **User management** (Admin): create, edit, activate/deactivate, assign roles and calendar colours, issue invitation and reset links. New active technicians appear in technician selection immediately; deactivated ones disappear from new assignments but stay on historical appointments.
- **Customers and installation sites**: repeat customers are found by name or phone while booking; one customer can have several sites and many appointments.
- **Appointments** with customer details, separate *apartment* and *floor* fields, access instructions, a saved map link and optional coordinates, product category / brand / model, description, required equipment, technician-visible notes, and **internal notes** that only authorised roles can see.
- **Multiple technicians per appointment** with **live availability** in the form and a **final, concurrency-safe conflict check** on the server (see below). Conflicts name the technician and the clashing appointment and time, and the form keeps everything you typed.
- **Persistent Sales colours**: every appointment remembers its original creator, and that person's colour is used in the calendar, lists, details and reports. The creator never changes on edits or technician reassignment.
- **Calendar**: day, week, month and agenda views; overlap-aware layout; Sales colour legend that doubles as a filter; technician and status filters; details panel; "now" line; refreshes every 30 seconds.
- **Dashboard**: today, upcoming, scheduled, completed, postponed, cancelled and **needs attention** (past end time but status not updated, no technician assigned, no map location) - all computed from the database and limited to what the user may see.
- **Search, filters, sorting and pagination** (ID, customer, phone, address, area, compound, brand/model, Sales employee, technician, date range, status, category) with CSV export of the filtered list.
- **Appointment details page** with a prominent **Open Location** button, click-to-call phone numbers, and a field-level **change history** (old → new values, who, when).
- **Configurable statuses** (rename, recolour, add; choose whether a status blocks technician time). Defaults: Scheduled, In Progress, Completed, Postponed/Rescheduled, Cancelled, Unable to Complete. Cancelled appointments free the technicians' time.
- **Reports**: appointments per day/month, by status, by Sales employee, by category, completed vs cancelled, technician workload (hours and jobs) - each exportable to CSV. Internal notes are never exported.
- **Audit log** (Admin): append-only record of appointment, user, permission, status and settings changes. A database trigger blocks updates and deletes.
- **In-app notifications** for technicians when they are assigned, unassigned, or a job is rescheduled, updated or cancelled.
- **Responsive UI** (phone, tablet, desktop) with light, dark and system themes, accessible focus states, empty/error states and toast feedback.

## Quick start (local development)

**Prerequisites:** Node.js 20.9+ (22 recommended, see `.nvmrc`) and PostgreSQL 14+ with the standard `contrib` extensions (`btree_gist` and `pg_trgm`; included in the official Docker image, most distributions and managed providers).

```bash
# 1. Install dependencies
npm install

# 2. Start PostgreSQL (or use your own server - see below)
docker compose up -d          # creates installation_manager and installation_manager_test

# 3. Configure environment
cp .env.example .env          # then edit the values; for the compose database use:
#   DATABASE_URL="postgresql://ims:ims_dev_password@localhost:5432/installation_manager?schema=public"
#   TEST_DATABASE_URL="postgresql://ims:ims_dev_password@localhost:5432/installation_manager_test?schema=public"

# 4. Create the schema and load demo data
npm run db:migrate
npm run db:seed

# 5. Run
npm run dev                   # http://localhost:3000
```

Using your own PostgreSQL instead of Docker:

```sql
CREATE ROLE ims WITH LOGIN PASSWORD 'choose-a-password' CREATEDB;
CREATE DATABASE installation_manager OWNER ims;
CREATE DATABASE installation_manager_test OWNER ims;
```

`CREATEDB` is only needed for `prisma migrate dev` (which uses a temporary shadow database while you develop schema changes); `npm run db:migrate` (`prisma migrate deploy`) does not need it.

Useful scripts:

| Command | What it does |
|---|---|
| `npm run dev` | Development server |
| `npm run build` / `npm start` | Production build / server |
| `npm run lint` · `npm run typecheck` | ESLint · TypeScript |
| `npm test` | Unit + integration tests (uses `TEST_DATABASE_URL`) |
| `npm run test:e2e` | Playwright browser tests (needs a seeded database) |
| `npm run db:migrate` | Apply migrations (`prisma migrate deploy`) |
| `npm run db:migrate:dev` | Create a new migration while developing |
| `npm run db:seed` | Demo data (only on an empty database; `SEED_FORCE=1` wipes and reseeds - never in production) |
| `npm run db:reset` | Drop, re-migrate and reseed the development database |
| `npm run create-admin` | Create the first Admin in a fresh production database |
| `npx tsx scripts/perf/…` | Performance measurements: large test data set, response times and SQL counts, browser timings, load test (see [docs/PERFORMANCE.md](docs/PERFORMANCE.md)) |

## Demo accounts

Created by `npm run db:seed`. Password for all of them: **`ChangeMe123!`** (or `SEED_PASSWORD`).

| Role | Email | Notes |
|---|---|---|
| Admin | `admin@example.com` | everything |
| Sales | `sara.sales@example.com`, `omar.sales@example.com`, `mona.sales@example.com` | each has a calendar colour |
| Technician | `karim.tech@example.com`, `youssef.tech@example.com`, `ahmed.tech@example.com`, `mostafa.tech@example.com` | sees only their assignments |
| Technician (inactive) | `hany.tech@example.com` | cannot sign in; kept on past appointments |
| Accountant | `nadia.accounts@example.com` | finance statement and cash hand-over; read-only bookings |
| Store keeper | `store@example.com` | stock by serial number, custody, models and warranty |
| Viewer | `viewer@example.com` | appointments, address/map and reports, read-only |

The seed creates ~100 non-overlapping appointments from three weeks ago to three weeks ahead (in `Africa/Cairo`), with prices, deposits, collections, cash custody and serial-numbered stock (some installed with warranty). It only runs on an empty database, so a database seeded before the Accountant and Store keeper roles existed has neither account: an Admin can create them under Users. **Never run the seed against production.**

## Roles & permissions

Permissions are defined once in [`src/lib/permissions.ts`](src/lib/permissions.ts) and enforced on the server in every service function ([`src/server/access.ts`](src/server/access.ts)). The UI only hides what the server would refuse anyway.

| Capability | Admin | Sales | Technician | Accountant | Store keeper | Viewer |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| See appointments | all | all | **assigned only** | all | all | if granted |
| Create / edit / reschedule / assign / change status / cancel | ✓ | ✓¹ | - | - | - | - |
| Record the visit outcome (started / done / unable / needs another visit) with a report, the amount collected and the serials installed | ✓ | ✓¹ | assigned only | - | - | - |
| Day plan: one WhatsApp message per technician, customer reminders | ✓ | ✓ | - | - | - | - |
| Prices, deposits and payment details | ✓ | ✓ | amount to collect only | ✓ | - | - |
| Finance statement, cash with technicians, finance CSV | ✓ | - | - | ✓ | - | - |
| Confirm cash handed over by a technician | ✓ | - | - | ✓ | - | - |
| Stock by serial number | ✓ | - | own custody | ✓ | ✓ | - |
| Goods in, hand to / take back from technicians, returned / faulty, models & warranty | ✓ | - | - | - | ✓ | - |
| Leave: ask for / withdraw own leave | - | - | ✓ | - | - | - |
| Leave: approve, reject, record, cancel for any technician | ✓ | - | - | - | - | - |
| Customer phone numbers | ✓ | ✓ | ✓² | ✓ | - | if granted |
| Address, apartment, floor, map link | ✓ | ✓ | ✓ | - | - | if granted |
| Internal notes | ✓ | ✓ | - | - | - | if granted |
| Appointment history | ✓ | ✓ | - | - | - | if granted⁴ |
| Customer directory | ✓ | ✓ | - | ✓ | - | if granted |
| Reports & CSV exports | ✓ | ✓³ | - | - | - | if granted |
| Users, roles, colours, settings, statuses, audit log | ✓ | - | - | - | - | - |

¹ An Admin can restrict Sales to editing only the appointments they created (Settings → "Sales can edit any appointment").
² Configurable (Settings → "Technicians see customer phone numbers").
³ Configurable (Settings → "Sales can view reports").
⁴ Amounts in the history are shown as "(hidden)" to Viewers.

Rules worth knowing:

- A technician requesting someone else's appointment - by URL, API or guessed ID - gets the same **404** as for a non-existent record. All list, calendar, dashboard and export queries are scoped the same way.
- Fields a user may not see are **removed from API responses** (not just hidden), and users cannot search by data they may not see (e.g. phone numbers).
- The original Sales creator, the acting user and role always come from the session. Values sent by the browser for these are ignored. Only an Admin may record a booking *on behalf of* a Sales employee, and only at creation.
- Changing a user's role, permissions, email or active state signs them out everywhere. You cannot deactivate yourself, and the last active Admin cannot be removed.
- State-changing API requests from another origin are rejected (in addition to `SameSite` cookies).

## How double-booking is prevented

A technician can never hold two overlapping appointments in a status that blocks the schedule. This is enforced at three levels:

1. **Live check in the form.** As soon as a date, time and duration are chosen, every active technician is shown as *Available* or *Busy* (with the clashing appointment). Busy technicians cannot be ticked.
2. **Authoritative check on save (server).** Inside a database transaction the server takes a PostgreSQL advisory lock per selected technician (in sorted order, so no deadlocks), then checks each technician individually for overlaps using real start **and** end times (half-open intervals, so 10:00-11:00 and 11:00-12:00 are fine). The appointment being edited is excluded from its own check. Requests for the same technician are serialised, so two simultaneous bookings cannot both pass.
3. **Database constraint (last line of defence).** `appointment_technicians` carries an `EXCLUDE USING gist (technicianId WITH =, tstzrange(startsAt, endsAt) WITH &&) WHERE (blocksSchedule)` constraint, so PostgreSQL itself rejects an overlapping row, even from a bug or a manual insert.

Cancelling (or moving to any status with *Blocks technician schedules* off) frees the time immediately. Re-activating a cancelled appointment re-runs the conflict check. Duplicate submissions (double clicks, retries) are idempotent via a client request ID, and concurrent edits of the same appointment are caught by optimistic locking ("changed by someone else - reload").

An optional **travel buffer** (Settings, default 0 minutes) requires a minimum gap between two jobs of the same technician.

All of this is covered by integration tests, including a test that fires six simultaneous bookings for the same technician and asserts exactly one succeeds.

## Dates, times and timezones

- Appointment times are stored as exact instants (`timestamptz`).
- Entry and display always use the **company timezone** from Settings (default `Africa/Cairo`), never the browser's timezone, so every user sees the same wall-clock time regardless of where their device is set. Calendar days, "today", reports and CSV exports use the same timezone.
- The end time is calculated from the start time and duration, and shown live in the form.

## Architecture

```
prisma/
  schema.prisma            data model
  migrations/              SQL migrations (incl. exclusion constraint + audit trigger)
  seed.ts                  development demo data
scripts/create-admin.ts    bootstrap the first Admin in production
src/
  app/
    (auth)/                login, set-password
    (app)/                 authenticated pages: dashboard, calendar, appointments,
                           customers, reports, users, settings, audit, profile
    api/                   JSON route handlers (thin: auth + parse -> service)
  server/                  server-only code (never shipped to the browser)
    auth/                  sessions, password hashing, rate limiting, tokens
    services/              business logic & data access (appointments, scheduling,
                           users, statuses, settings, reports, dashboard, audit ...)
    access.ts              permission checks and row-level scoping
    http.ts                API wrapper: session, origin check, safe error responses
  lib/                     shared, framework-free code: validation (zod), permissions,
                           time/timezone helpers, map-link handling, colours, types
  components/              UI (design-system primitives, layout, calendar, forms ...)
tests/                     Vitest unit + integration tests (real PostgreSQL)
e2e/                       Playwright browser tests
```

- **Validation**: the same Zod schemas validate in the browser (instant feedback) and on the server (authoritative).
- **Reads** happen in React Server Components via the service layer with the current user. **Writes** go through `/api/*` route handlers that call the same services. Every service function receives the acting user and checks permissions itself.
- **Errors**: services throw typed errors (validation, conflict, forbidden, not found, stale). The API returns them as structured JSON. Unexpected errors are logged on the server with a reference ID and the user only sees a generic message (no stack traces).
- **Freshness**: dashboard, list and detail pages refresh every 30 seconds and when the tab regains focus. The calendar re-fetches its range on the same schedule (an unchanged range costs a `304` with no body), and notifications poll every 60 seconds. Business data is never cached: every request reads the database.

## Database

Main tables: `users`, `sessions`, `password_tokens`, `login_attempts`, `customers`, `customer_locations`, `appointments`, `appointment_technicians`, `appointment_statuses`, `audit_logs`, `notifications`, `settings`.

- Stable `cuid` IDs, plus a sequential appointment number shown as `APT-000123`.
- `appointments.createdById` is the permanent original Sales creator; `updatedById` is the last editor.
- Users are never deleted, only deactivated, so historical references survive. Foreign keys use `ON DELETE RESTRICT` for appointment data, and appointments are cancelled, never deleted.
- Check constraints for time ranges, durations and colour formats; indexes for the common filters (dates, status, creator, technician, customer, area, building, phone digits).
- Audit rows are append-only (trigger).

## Testing

```bash
npm test            # 118 unit + integration tests (needs TEST_DATABASE_URL; that database is wiped)
npm run test:e2e    # 15 Playwright tests against a running, seeded app
```

What is covered:

- **Scheduling**: multi-technician creation; partial, full and containing overlaps; back-to-back bookings; per-technician checks; **simultaneous conflicting bookings**; the DB constraint when the service is bypassed; reschedule with self-exclusion; cancellation freeing the slot; re-activation re-checking; travel buffer; idempotent duplicate submissions; optimistic locking.
- **Permissions**: technician scoping (lists, calendar, details, 404 for others' jobs), technician read-only for every write, viewer restrictions and redaction (no phone/address/internal notes unless granted, no phone search), Sales vs Admin powers, history redaction.
- **Users**: automatic technician availability after creation, deactivation removing them from assignment, colours, invitation links (single use), duplicate emails, last-Admin protection, session revocation.
- **Audit & reports**: history entries with old/new values, append-only enforcement, report aggregates, CSV without internal notes and with formula-injection protection.
- **Booking details and field work**: visit type, customer confirmation with optimistic locking, closed weekdays (Admin override only), follow-up links scoped for technicians; the technician's visit outcome with a mandatory report, notifications, and the "needs another visit" dashboard alert until a follow-up is booked.
- **Leave**: requests, approval/rejection, Admin-recorded leave, overlap and date rules; approved leave refusing bookings on company-local days (including visits that cross midnight), re-checks only when a booking moves to other days or is re-activated, existing bookings reported to their Sales creators and flagged on the dashboard.
- **Payments**: price/deposit/extra-fee validation (also on partial edits), per-role redaction (technicians only see what to collect, viewers see no amounts, history amounts hidden), collections recorded with the outcome, cash custody from collection to the accountant's receipt (corrections, non-cash payments, stale receipts, office collections), the monthly statement totals by method, balances owed, and the finance CSV.
- **Inventory**: model names unique regardless of case, serial normalisation and duplicate refusal, custody hand-over and return with notifications, technicians seeing only their own custody, append-only movement history, installation only from the technician's own custody (or from the store by a manager), warranty from the visit date, refusal of unknown / faulty / already-installed serials without partial changes, and the faulty-unit swap.
- **Day plan**: grouping of a day's active visits per technician (cancelled/postponed left out, unassigned listed separately), shared visits, amounts still to collect, WhatsApp number normalisation (local 0… numbers become 20…) and message text.
- **SQL reads**: the hand-written list/calendar/export queries return exactly what the Prisma filters return (300 random filter combinations), including literal `%`/`_` in search terms.
- **API**: login/logout with cookies, generic login errors, rate limiting, cross-origin rejection, malformed JSON, 401/403/404/409 responses, server-assigned creator.
- **Browser (Playwright)**: booking with two technicians, separate apartment/floor, Open Location link, rescheduling with history, cancellation, a real race where a colleague books the technician first (conflict shown, form data kept), calendar legend and panel, technician and viewer restrictions, no horizontal scrolling at 390 px on every main page, mobile navigation, a technician recording the visit outcome, Sales recording the customer's confirmation, a technician asking for leave that the Admin approves (the technician then cannot be booked that day), a technician collecting cash that the Admin then receives on the finance page, the store handing serials to a technician who installs one at the visit (warranty shown, custody updated), and Sales opening the day plan with a WhatsApp link per technician.

CI (`.github/workflows/ci.yml`) runs lint, typecheck, all tests, the production build and the browser tests against PostgreSQL 16.

## Deployment

Any Node.js host (a VM, Docker, Render, Railway, Fly.io, ...) plus a managed PostgreSQL 14+ database:

```bash
npm ci
npm run db:migrate          # prisma migrate deploy
npm run build
ADMIN_EMAIL=owner@company.com ADMIN_NAME="Owner" ADMIN_PASSWORD='a-strong-password-1' npm run create-admin
npm start                   # or: npx next start -p $PORT
```

Then sign in, set the timezone in **Settings**, and add Sales, Technician and Viewer accounts in **Users** (each new account gets a one-time link to set their password).

Production checklist:

- Serve over **HTTPS** and set `APP_URL` to the public `https://` URL. Session cookies are then marked `Secure`.
- Run behind a reverse proxy that sets `X-Forwarded-For` (used for per-IP login rate limiting; the per-account limit applies regardless).
- Back up the PostgreSQL database regularly.
- Do **not** run `npm run db:seed` in production (it refuses unless forced).

Serverless platforms work too. Use a pooled connection string for `DATABASE_URL` if your provider recommends one. Keep the database close to the app (same region): each page needs a few database round trips, so distance adds directly to every page load.

## Environment variables

| Variable | Required | Description |
|---|:-:|---|
| `DATABASE_URL` | ✓ | PostgreSQL connection string |
| `APP_URL` | ✓ | Public base URL; used in password links and to decide `Secure` cookies |
| `SESSION_TTL_HOURS` | | Session lifetime (default 12) |
| `TEST_DATABASE_URL` | tests | Separate, disposable database for `npm test` (must differ from `DATABASE_URL`) |
| `SEED_PASSWORD` | | Password for demo accounts (default `ChangeMe123!`) |
| `ADMIN_EMAIL` / `ADMIN_NAME` / `ADMIN_PASSWORD` | | Inputs for `npm run create-admin` |
| `E2E_BASE_URL` | | Point Playwright at an already running app |

No secrets are committed. `.env` is git-ignored and `.env.example` documents the format.

## Branding

- The supplied logo is used unmodified (`public/brand/logo.png`, cropped from the provided image only to remove the surrounding screenshot frame; the original is kept in `docs/brand/logo-source.png`). It appears on the login page and in the sidebar. In dark mode it sits on a white tile instead of being recoloured.
- Colours were **sampled from the logo**: orange `#E55823` and the charcoal of "Smart Home Systems" `#292929`. The orange is used for accents, active navigation, focus rings and highlights. Primary buttons use `#C44617`, a deeper shade of the same orange, because white text on `#E55823` only reaches a 3.65:1 contrast ratio. `#C44617` reaches 4.96:1 (WCAG AA).
- Design tokens live in [`src/app/globals.css`](src/app/globals.css) (light and dark).
- The default Sales calendar colours were checked as a categorical palette (lightness, chroma, colour-blind separation, contrast) on both light and dark backgrounds, and every colour is always shown next to the person's name.
- Typeface: Poppins (self-hosted by `next/font` at build time).

## Notifications - what is and isn't included

- **Included:** in-app notifications (bell icon) for technicians: new assignment, removal, reschedule, update, status change and cancellation. Pages and the calendar also refresh automatically.
- **Not included:** email, SMS, WhatsApp or push. No such service is configured, so nothing is sent outside the app. Invitation and password-reset links are shown to the Admin, who passes them on. Adding an email provider would mean sending those links (and optionally the in-app notifications) from `src/server/services/users.ts` and `notifications.ts`.

## Performance

Measured on a production build with 33,000 appointments and 30,000 customers: pages respond in 12–75 ms with the database on the same machine and 30–145 ms with 20 ms of network distance to it; the calendar renders a month of 1,350 events without blocking the browser. What was slow, what changed and all measurements are in [docs/PERFORMANCE.md](docs/PERFORMANCE.md).

Judge speed on `npm run build && npm start`, not `npm run dev`: the development server compiles each page the first time it is opened and is several times slower.

## Known limitations

- No map picker or geocoding: Sales paste a map link (or coordinates). Coordinates can be read automatically from full Google Maps URLs. Short links (`maps.app.goo.gl`) are saved and opened as-is.
- Text search uses PostgreSQL `ILIKE` with `pg_trgm` indexes; search terms shorter than 3 characters cannot use them and scan instead.
- Recurring appointments and file attachments (photos, documents) are not implemented.
- The UI and the WhatsApp texts are in English. Dates use the `en-GB` format.
- WhatsApp messages are never sent automatically: the day plan opens WhatsApp with the text filled in (no WhatsApp Business API or e-mail provider is connected). Numbers without a country code are treated as Egyptian.
- Payment proofs (transfer screenshots), before/after photos and signatures need file storage and are not implemented; the repeat-visit fee is entered by Sales rather than set automatically.
- Not ported from Aura yet: GPS check-ins and the live technician board, attendance and points, complaints, transport expenses, the company car route, slot holds and quotation parsing (see [docs/AURA-FEATURE-MATRIX.md](docs/AURA-FEATURE-MATRIX.md)).
