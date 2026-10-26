# System audit

Audit of the two code bases that make up Aura's installation management, done by reading the source
(not only the READMEs), running the existing checks, and tracing the main workflows.

| | Modern system (this repository) | Legacy system (`aura-source.zip`) |
|---|---|---|
| Stack | Next.js 16 (App Router), React 19, TypeScript, Tailwind 4, Prisma 6, PostgreSQL 16 | Google Apps Script web app (`Code.gs`, 2,591 lines) + one HTML/JS page (`Index.html`, 2,306 lines); a stand-alone copy (`dist/`) that calls the script over HTTPS |
| Storage | PostgreSQL, 11 versioned migrations | Google Sheet tabs used as tables (`DB_Orders`, `DB_Users`, `DB_Lists`, `DB_Log`, `DB_Checkins`, `DB_Stock`, `DB_Cash`, `DB_Complaints`, `DB_Notif`, `DB_Leaves`, `DB_Expenses`), script properties, script cache, Google Drive for files |
| Auth | E-mail + bcrypt password, server sessions (hashed token cookie), DB-backed rate limiting, invitation/reset links | 6-digit PIN per user stored in clear in `DB_Users`; session token in the script cache (6 h) |
| Language | English only, LTR | Arabic only (Egyptian dialect), RTL |
| Tests | 119 Vitest unit/integration tests on real PostgreSQL, 15 Playwright tests, CI workflow | Node harness with a mocked Apps Script runtime (`test/*.js`) and Python UI scripts |

Baseline on this branch before any change (run in this session): `npm run lint` clean, `npm run typecheck`
clean, `npm test` **119/119 passed**, `npm run build` succeeded.

---

## 1. Modern system

### 1.1 Architecture

```
src/app/(auth)        login, set-password (public)
src/app/(app)         authenticated pages (server components read via services)
src/app/api/**        JSON route handlers: apiRoute() = origin check + session + error mapping -> service
src/server/services   business logic; every function receives the acting user and checks permissions
src/server/access.ts  permission checks + row-level scope (technicians see only their assignments)
src/lib               shared, framework-free code (zod schemas, permissions, time, maps, constants)
src/components        UI (design-system primitives, calendar, forms, managers)
prisma/               schema, migrations (incl. exclusion constraint and audit trigger), seed
```

Entry points: `src/app/layout.tsx` (root), `src/app/(app)/layout.tsx` (requires a session and renders
`AppShell`), `src/server/http.ts` (`apiRoute`/`publicRoute`). Environment: `DATABASE_URL`,
`TEST_DATABASE_URL`, `APP_URL`, `SESSION_TTL_HOURS`, `SEED_PASSWORD`, `ADMIN_*`, `E2E_BASE_URL`.

### 1.2 Implemented functionality (verified in code)

| Area | What exists | Where |
|---|---|---|
| Auth & sessions | bcrypt (cost 12), constant-time dummy compare, 256-bit token in `HttpOnly SameSite=Lax` cookie, only SHA-256 stored, sliding `lastSeenAt`, DB rate limiting (5/email, 30/IP per 15 min), one-time invite/reset links, sign-out everywhere on role/permission change | `src/server/auth/*`, `services/users.ts` |
| Roles | ADMIN, SALES, TECHNICIAN, ACCOUNTANT, STORE, VIEWER (+ per-viewer grants) | `src/lib/permissions.ts` |
| Customers & sites | customers with phone digits for search, many sites per customer, repeat-customer lookup | `services/customers.ts` |
| Appointments | create/edit/reschedule/cancel/status, visit type, confirmation, follow-ups, internal notes, idempotent create (`clientRequestId`), optimistic locking (`version`) | `services/appointments.ts` |
| Double booking | advisory lock per technician + overlap query + PostgreSQL `EXCLUDE USING gist` constraint, travel buffer, leave check | `services/scheduling.ts`, migration `init` |
| Calendar | day/week/month/agenda, sales colour legend/filter, ETag polling | `components/calendar/calendar-view.tsx` |
| Dashboard | counters + "needs attention" list | `services/dashboard.ts` |
| Lists/search/export | SQL list with filters/sort/pagination, CSV export with formula-injection protection | `services/appointment-reads.ts`, `api/appointments/export` |
| Visit outcome | technician starts/finishes/unable/needs revisit with mandatory report | `recordVisitOutcome` |
| Leave | request/approve/reject/record/cancel, blocks bookings, clash notifications | `services/leaves.ts` |
| Payments | price/deposit/extra fee, collection with method, cash custody until the accountant receives it, monthly statement + CSV | `services/payments.ts` |
| Inventory | product models with warranty months, serial items, custody, returned/faulty, append-only movements, install at visit with warranty date | `services/stock.ts` |
| Day plan | one WhatsApp text per technician, customer reminder links | `services/day-plan.ts`, `lib/day-plan.ts` |
| Reports | by status/sales/category/technician/day + CSV | `services/reports.ts` |
| Audit | append-only `audit_logs` (DB trigger blocks UPDATE/DELETE), field-level history with per-permission redaction | `services/audit*.ts` |
| Notifications | in-app bell, polling | `services/notifications.ts` |
| UI | responsive, light/dark/system theme, accessible dialog, focus styles | `components/**` |

### 1.3 Defects, gaps and risks found

Severity: **H** high, **M** medium, **L** low.

| # | Sev | Finding | Evidence | Decision |
|---|:-:|---|---|---|
| M1 | H | **No localisation.** Every string is hard-coded English in ~70 files; `<html lang="en">` without `dir`; dates use hard-coded English month names (`src/lib/time.ts`), money is formatted with `en-GB` + `"EGP"` (`constants.ts`). The legacy users work in Arabic. | `src/lib/time.ts` `MONTHS`, `src/lib/constants.ts` `money()` | Fix (phase 3) |
| M2 | H | Server-generated text (validation/conflict errors, notification messages, audit summaries, CSV headers, WhatsApp texts) is English and stored as English text, so it cannot follow the reader's language. | `services/*.ts` | Fix: message descriptors (key + params) stored next to the text |
| M3 | M | Configurable status **names** are single-language data. | `appointment_statuses.name` | Fix: optional Arabic name column |
| M4 | M | Money arithmetic in JS uses binary floating point (`amountDue`, sums in `financeStatement`) and rounds afterwards. Values are stored as `NUMERIC(12,2)` so stored data is exact, but derived totals can be off by a cent for unlucky inputs. | `services/payments.ts` | Fix: integer minor units for derived amounts |
| M5 | M | `Permissions-Policy: geolocation=()` and `camera=()` block the browser features the legacy check-ins and photo capture need. | `next.config.ts` | Change to `(self)` when those features land |
| M6 | M | Per-IP login limit trusts the first `X-Forwarded-For` value; without a proxy that strips it the IP limit can be bypassed (the per-account limit still holds). | `auth/rate-limit.ts` | Documented; `TRUST_PROXY` switch added |
| M7 | L | No Content-Security-Policy header. | `next.config.ts` | Documented (needs nonce plumbing for Next inline scripts) |
| M8 | L | `GET /api/statuses` has no permission check (status names/colours only). | `api/statuses/route.ts` | Accepted: needed by every role's filters; no sensitive data |
| M9 | L | No file storage, so before/after photos, signatures and payment proofs from the legacy app have no equivalent. | README "Known limitations" | Fix (legacy migration) |
| M10 | L | Booking in the past is allowed for everyone; the legacy app limited it to managers. | `createAppointment` | Fix (legacy rule) |
| M11 | info | `docs/AURA-FEATURE-MATRIX.md` lists legacy features still missing: attendance/check-ins, points, complaints, expenses, car route, holds, quotation parsing, photos/signature/checklist, satisfaction rating, quality grade, maintenance reminders. | — | See the migration matrix |

No SQL injection risk was found: raw SQL goes through `Prisma.sql` tagged templates everywhere
(checked every `$queryRaw`/`$executeRaw`); the only `$executeRawUnsafe` is in the test helper.
No `dangerouslySetInnerHTML` except the static theme script. Map links are restricted to http(s)
without credentials, so stored links cannot run script.

---

## 2. Legacy system (Aura on Google Apps Script)

### 2.1 Architecture

* `doGet` serves `Index.html`; the page calls `google.script.run.api_*` functions. `doPost` exposes
  the same `api_*` functions as JSON over HTTPS for the stand-alone page in `dist/`.
* Every API function starts with `auth_(token, roles)`; data is read by loading whole sheet tabs
  (`readTable_`) and written row by row; a script-wide `LockService` lock serialises writers.
* Time-driven triggers: `morningReport` (9:00 e-mail), `lateCheck` (every 15 min), `syncTick`
  (every 5 min, copies orders back to the old month tabs).
* Roles: admin, headInstall, headSales, supervisor, sales, engineer, tech, driver, store, accountant,
  plus a token-based read-only "office screen".

### 2.2 Data model (sheet columns, from `OCOLS`, `UCOLS`, `CCOLS`, …)

* **Order** (`DB_Orders`, 56 columns): id `YYMM-NNN`, date, period code (`1`,`2`,`3`,`12`,`23`,`123`,`4`),
  engineers (comma-separated *names*), type (e.g. «تركيب لوك»), sales (name), client, phone(s), area,
  address, location link, required, count, door, notes, confirm, foundation, internet, remaining,
  status, report, photos, created/updated by/at, lockWhere, devices, visitKind, electrician, size,
  salesPhotos/techPhotos (JSON of Drive ids), collected, rating, ratingNote, followOf, maintNote,
  checklist (JSON), signature (Drive id), serials, payMethod, payPhoto, extraFee, warrantyUntil,
  qGrade, readyPhoto, quote (URL), car, carSeq, total, deposit, depositMethod, depositPhoto.
* **Users**: name, role, PIN, list name ("link"), active, phone, specialty (lock / smart home / both).
* **Check-ins**: ts, date, user, kind (`company`, `pickup`, `ready`, `depart`, `arrive`, `start`, `done`,
  `problem`, `leave`, `car_go`, `car_drop`, `car_pick`, `car_back`), order, lat/lng/accuracy,
  distance, note (flags such as "late 25 min", "far from client 1.2 km"), ETA.
* **Stock** (serial, model, kind, status, holder, order, in/out, by, note), **Cash** (one row per
  collection: tech, order, amount, method, status, received by/at), **Complaints** (id `CYYMM-NNN`,
  order, client, phone, original engineers, description, status جديدة/اتوزعت/اتحلت/مقفولة, assignedTo,
  visitId, resolution, closedBy/At, warranty text), **Notifications**, **Leaves**, **Expenses**
  (user, order, amount, kind = transport, note, receipt photo, status pending/paid, paidBy/At).
* Identifiers are human names (engineers, sales) and sheet row numbers (`_row`), not stable ids.

### 2.3 Business rules found in the code

* Periods: 11:30–13:30, 14:30–16:30, 17:30–19:30, two-period and whole-day combinations, "after
  hours"; conflict = same engineer + same date + overlapping slot. Managers may "force" a booking.
* Friday closed; Saturday smart-home inspections only (warning); phone must be 11 digits starting 01;
  no booking in the past except managers; 10-minute slot holds while Sales is on the phone.
* Done requires (for install/completion visits) every checklist item, an after-photo, optionally
  serials (setting), always a customer signature, and a transfer photo when paid by non-cash.
* A "problem" check-in caused by the client adds the configured repeat-visit fee to the order.
* Cash collected on "done" becomes custody of the first engineer until the accountant receives it,
  oldest first, whole orders only.
* Attendance: arrive by 10:00 (+15 min grace), leave at 19:00; absence = a day with a visit in the
  person's name and no check-in and no approved leave.
* Monthly points per technician: up to 40 for on-time arrivals (≤15 min after the slot start), up
  to 30 from client ratings, up to 20 from the head's quality grade, +1 per finished visit (max 10),
  −5 per revisit, −10 per complaint, −2 per late day, −5 per absence, floor 0.
* Maintenance reminders 6 and 12 months after an installation (window −7…+21 days).
* Satisfaction call due 3–14 days after a finished visit without a rating; quality grade due for
  finished visits with photos in the last 30 days.
* Car route: visits flagged "by car" are ordered by manual sequence, then per period by nearest
  neighbour from the company location; warnings for > 3 drops per period or two drops ≥ 20 km apart.
* Quotation link (aura.eg page) is fetched server-side and its table parsed into items; prices are
  removed for engineers/technicians.

### 2.4 Legacy risks (why it should not be carried forward as-is)

| Risk | Detail |
|---|---|
| Weak authentication | 6-digit PINs in clear text in a sheet; one global failure counter (30 fails → everyone locked out for 10 min) |
| Public customer files | every photo, signature, payment proof and receipt is shared "anyone with the link" on Drive |
| Data integrity | names as foreign keys, sheet row numbers as ids, whole-table rewrites, manual edits in month tabs overwrite app data on sync |
| Concurrency | one script lock for all writers; holds and sessions live in a 6-hour cache that can be evicted |
| Personal data in source | `Legacy.gs` embeds December 2025 / January 2026 orders with real names and phone numbers |
| Hard-coded deployment | `APP_URL` of the deployment, company coordinates auto-taken from the first check-in |

These are the reasons the modern architecture stays primary and legacy behaviour is re-implemented
on top of it (see `FEATURE_MIGRATION_MATRIX.md`) instead of copied.

### 2.5 Deployment requirements found

Modern: Node ≥ 20.9, PostgreSQL ≥ 14 with `btree_gist` and `pg_trgm`, `npm run db:migrate`,
`npm run build`, `npm start`, HTTPS + `APP_URL`. Legacy: an Apps Script deployment of the sheet
owner, Gmail/Drive scopes, three time triggers.
