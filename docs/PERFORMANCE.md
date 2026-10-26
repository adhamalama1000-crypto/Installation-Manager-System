# Performance audit (October 2026)

What made the app slow and freeze, what was changed, and the measurements before and after. All
numbers come from the scripts in [`scripts/perf/`](../scripts/perf) and the raw results are in
[`docs/performance/`](performance).

## How it was measured

- **Production build** (`next build && next start`), never the dev server. The dev server compiles
  each route on first visit and is several times slower; judge performance only on a build.
- **Data volume:** `scripts/perf/seed-large.ts` created about 2.5 years of history for a busy company in a
  separate database: 54 users (40 technicians), 30,000 customers / 36,070 sites, 33,249
  appointments, 41,425 technician assignments, 73,541 audit entries and 41,425 notifications. (The
  demo seed has only 93 appointments, which hides every scaling problem.)
- **Database distance:** PostgreSQL 16 on the same machine (≈0 ms), and through a TCP proxy adding
  10 ms each way (20 ms round trip, typical for a managed database in the same region; across regions it is
  often 50–100 ms, which makes round trips count even more).
- **SQL work per request:** `pg_stat_statements` (statement count and execution time).
- **Browser:** Playwright/Chromium, 1440×900, without throttling and with 4× CPU throttling (a
  typical office laptop or phone).
- **Machine:** 4 vCPU container; numbers vary ±10–20 % between runs.

## What was actually wrong

| # | Problem | Evidence |
|---|---|---|
| 1 | **The calendar froze the browser.** For every render it converted every event's times for every visible day: ~113,000 timezone conversions for a month of 1,353 events, with nothing memoised. The 30-second poll repeated it. | Month view: one main-thread task of 3.5 s at 4× CPU (0.8 s unthrottled); switching to Month took 4.9 s. |
| 2 | **Many sequential database round trips per page.** Prisma loads every `include`d relation with a separate query, one after another; each request also ran 3 queries just for the session; the appointment page loaded the appointment twice. | Dashboard 22 statements, appointment page 22, list 14. With 20 ms to the database: 634 ms, 472 ms, 438 ms. |
| 3 | **Search scanned and joined whole tables.** Each OR'ed relation filter became its own LEFT JOIN (customers ×3, locations ×3) over the whole table, and `ILIKE '%…%'` cannot use a B-tree index. | Phone search: 300 ms of SQL at 33k appointments, growing linearly with data. |
| 4 | **Customers list aggregated everything.** Counts and "latest appointment" were computed for all 30,000 customers to show 25. | 88 ms of SQL per page view. |
| 5 | **CSV exports spent seconds in the ORM.** 12k rows with nested relations: ~70 ms of SQL, ~3 s turning Prisma's nested results into objects. | Export of one year: 3.8 s. |
| 6 | **API responses were not compressed.** `next start` gzips pages, not route handlers. | Month of calendar data: 951 KB on the wire; re-downloaded every 30 s (1.8 MB/min per open calendar). |
| 7 | **Background prefetch storms.** Every 30-second auto-refresh cleared the router cache and every visible link (35 on the dashboard) prefetched again. | 71 requests per minute from one idle dashboard tab. |
| 8 | **No feedback while navigating.** Every page is rendered on demand, and nothing changed on screen until the server finished. | 0.3–0.7 s of an unchanged screen after a click at 4× CPU. |

Checked and found **not** to be a problem: memory (heap stays 12–19 MB, intervals and listeners are
cleaned up), middleware (there is none; auth is one query now), client bundle size (typical for
Next.js; icons are tree-shaken), booking form typing (slowest key event 16 ms unthrottled, 56 ms at
4× CPU, well under the 200 ms "good" threshold), console errors (none in the e2e runs).

## What was changed

- **Calendar** (`calendar-view.tsx`): per-event day keys, minutes and labels computed once per fetch,
  events bucketed by day, grids memoised, redraws in a React transition, off-screen agenda days skip
  layout. Polls send the ETag they have and skip download and re-render when nothing changed.
- **Fewer round trips:** one query for session + user + settings; lists, calendar, dashboard and
  exports load each appointment with its customer, location, status, creator and technicians in one
  SQL statement (`appointment-reads.ts`); appointment details in 2 round trips instead of 7, without
  loading the appointment twice; dashboard queries all run in parallel.
- **Search:** each alternative is an indexed sub-query; **additive migration**
  `20261025200000_search_indexes` adds `pg_trgm` GIN indexes for the text searches and an index for
  the customer list order (no data or columns change; rollback SQL is in the migration).
- **Paging:** per-row work only for the rows on the page (deep pages were evaluated for every skipped
  row); calendar ranges carry a lower bound so the index is used with generic prepared plans.
- **Formatting:** cached `Intl` formatters (8× faster than `date-fns-tz` per call), verified to give
  identical output for every pattern, several timezones and DST transitions.
- **Network:** API JSON/CSV gzip-compressed; GET responses carry an ETag (304 when unchanged). Data is
  always read fresh from the database first, so nothing stale is ever served. **No caching of
  business data was added.**
- **Navigation:** a top progress bar from the moment an in-app link is clicked, and a pending dot on
  the clicked sidebar link. Per-row links no longer prefetch.
- **Correctness safety net:** `tests/integration/appointment-reads.test.ts` checks that the SQL filter
  returns exactly the same rows as the original Prisma filter for 6 user types and 300+ filter
  combinations (permission scoping and redaction included), the same sort orders, and pins the
  dashboard and customer figures (those pinned tests also pass on the original code).
- Search input `%` and `_` are now matched literally (previously they acted as wildcards).

A route-level loading skeleton (`loading.tsx`) was tried and **removed**: React deliberately keeps a
skeleton on screen for at least ~300 ms, so fast navigations (≈100 ms) got slower. The progress bar
gives immediate feedback without that delay.

## Results

### Server: median response time and SQL statements per request

| Page / API | Statements | Local DB (ms) | 20 ms to DB (ms) |
|---|---:|---:|---:|
| Dashboard | 22 → 16 | 70 → 72 | **634 → 137** |
| Dashboard (technician) | 21 → 12 | 61 → 41 | **557 → 89** |
| Appointments list | 14 → 6 | 48 → 37 | **438 → 74** |
| Appointments, search by name | 14 → 6 | 160 → 74 | 266 → 118 |
| Appointments, search by phone | 14 → 6 | 255 → 75 | 387 → 139 |
| Appointments, sort by customer | 14 → 6 | 99 → 38 | 426 → 78 |
| Appointments, page 1000 | 14 → 6 | 87 → 51 | 296 → 100 |
| Appointment details | 22 → 11 | 28 → 19 | **472 → 122** |
| Edit appointment | 14 → 10 | 25 → 14 | 298 → 144 |
| New appointment | 6 → 4 | 20 → 12 | 101 → 76 |
| Customers | 7 → 3 | 97 → 12 | 208 → 56 |
| Customers, search | 7 → 3 | 126 → 18 | 276 → 63 |
| Customer details | 8 → 4 | 23 → 16 | 192 → 79 |
| Reports (this month) | 12 → 9 | 43 → 37 | 230 → 76 |
| Reports (this year) | 11 → 10 | 51 → 42 | 143 → 112 |
| Users | 4 → 2 | 25 → 18 | 147 → 101 |
| Settings | 6 → 4 | 17 → 14 | 106 → 57 |
| Audit log | 7 → 5 | 26 → 20 | 132 → 93 |
| Audit log, search | 7 → 5 | 83 → 69 | 194 → 124 |
| Calendar data, week | 10 → 2 | 48 → 24 | **388 → 64** |
| Calendar data, 6-week month | 10 → 2 | 210 → 77 | 518 → 202 |
| Notifications | 5 → 3 | 8 → 8 | 93 → 51 |
| Customer look-up (booking form) | 5 → 3 | 24 → 8 | 132 → 74 |
| Technician availability (booking form) | 9 → 7 | 18 → 15 | 210 → 168 |
| CSV export, one year (12k rows) | 10 → 2 | **3,780 → 606** | **3,448 → 659** |
| Reports CSV, one year | 10 → 2 | **3,260 → 612** | **3,326 → 705** |

The dashboard's local time is unchanged: it now issues fewer, parallel queries (which is what matters
once the database is not on the same machine), but its individual queries do slightly more work.

### Under concurrent use (20 ms to DB, mixed pages and API calls, 30 s)

| Users | Throughput | p50 | p95 | p99 | Errors |
|---:|---:|---:|---:|---:|---:|
| 5 | 18.5 → **40.4 req/s** | 273 → **119 ms** | 510 → **220 ms** | 712 → 279 ms | 0 → 0 |
| 20 | 35.6 → **54.9 req/s** | 569 → **386 ms** | 1,069 → **628 ms** | 1,264 → 725 ms | 0 → 0 |

### Browser

| Measurement | 1× CPU | 4× CPU |
|---|---:|---:|
| Month view: load + render | 1,275 → **328 ms** | 4,168 → **643 ms** |
| Month view: main thread blocked | 793 → **0 ms** | **3,412 → 0 ms** |
| Switch to Month (blocked) | 1,258 → 269 ms | **4,946 (4,158) → 705 (0) ms** |
| Switch to Week (blocked) | 710 → 180 ms | **3,363 (2,701) → 655 (227) ms** |
| Week view blocked | 38 → 0 ms | 484 → 16 ms |
| Agenda view blocked | 92 → 0 ms | 839 → 0 ms |
| Sidebar → Appointments ready | 201 → 150 ms | 695 → 531 ms |
| Sidebar → Customers ready | 211 → 86 ms | 325 → 181 ms |
| Sidebar → Reports / Audit / Dashboard ready | 98 / 87 / 128 → 140 / 86 / 144 ms | 285 / 253 / 363 → 322 / 277 / 339 ms |
| Booking form, slowest keystroke | 24 → 16 ms | 56 → 56 ms |
| Idle dashboard tab, requests per minute | 71 → 35 | 60 → 29 |
| Idle month calendar, data downloaded | 1,828 KB/min → **0 KB** | — |

Network size of one month of calendar data: **951 KB → 92 KB** (gzip); an unchanged poll: **0 KB**
(HTTP 304). One-year CSV export: 2.85 MB → 476 KB on the wire.

## Checks run

`npm run lint`, `npm run typecheck`, `npm test` (75 unit + integration tests, 10 new), `npm run build`
and `npm run test:e2e` (9 Playwright tests against the production build) all pass.

## Known remaining issues

- **Server rendering CPU** becomes the limit at ~20 simultaneous active users on 4 vCPUs (p95 628 ms
  at 20 ms to the database). Scale out with more instances or CPUs if needed.
- **Technician availability** (booking form) still takes 5 round trips (~170 ms at 20 ms to the
  database); it is debounced, so it does not block typing.
- **Month view for a large team** sends ~1,350 events (92 KB compressed) and the busiest week view
  still has one ~180 ms task at 4× CPU when switching.
- **Search terms under 3 characters** cannot use the trigram indexes (they still work, by scanning).
- **Exports** above 20,000 rows are cut off (unchanged behaviour); a one-year export takes ~0.6 s.
- The large data set is synthetic; real data may stress other paths. Run `scripts/perf/measure.ts`
  against a copy of production data to confirm.

## Re-check after the Aura features (October 2026)

Same 33k-appointment data set, warm servers (60 requests per page before 20 measured), median of
the 20, admin user. "Old" is the build from before the Aura features (commit `e531063`), "new"
is this branch. Both read identical data: the old build gets a copy of the database without the
"Needs another visit" status row, which its generated client cannot read.

| Page / API | Local, old | Local, new | 20 ms to DB, old | 20 ms to DB, new |
|---|---|---|---|---|
| Dashboard | 32.8 ms | 42.7 ms | 122.3 ms | 87.1 ms |
| Appointments list | 271.2 ms | 31.1 ms | 297.9 ms | 74.3 ms |
| List search "Ahmed" | 260.5 ms | 68.9 ms | 321.4 ms | 112.7 ms |
| Appointment page | 14.0 ms | 19.5 ms | 76.8 ms | 80.7 ms |
| Calendar page | 246.8 ms | 13.3 ms | 278.6 ms | 54.7 ms |
| Customers | 13.2 ms | 13.3 ms | 57.1 ms | 54.0 ms |
| Reports | 30.5 ms | 33.3 ms | 95.6 ms | 68.3 ms |
| Calendar week API | 15.8 ms | 16.8 ms | 64.9 ms | 66.3 ms |

What changed to get there:

- The list of Sales people (calendar legend, Sales filter, booking form, settings) took 190–250 ms
  once PostgreSQL's statistics led it to scan all appointments for every user who never booked. It
  now walks the distinct creators through an index (0.5 ms).
- List, calendar and dashboard reads no longer degrade under PostgreSQL's generic plans (technicians
  are read per row through the primary key instead of joining a separately aggregated set).
- The dashboard's six counters are one statement. With six separate ones the page sent 14
  statements at once through a pool of 9 connections, which costs an extra database round trip.

Correction: the first pull request reported the dashboard and appointment page as slower than before
the Aura features at 20 ms. That comparison was wrong: the old build was answering those pages with
HTTP 500 (it could not read the new status row) and therefore looked fast. The table above compares
two builds that both return the full pages.

Measuring note: Prisma prepares each statement once per pooled connection. After a restart a page
needs a few dozen requests before every connection has every statement prepared; cold numbers include
an extra round trip per unprepared statement.

## Reproducing

```bash
createdb installation_manager_perf   # owned by the app's database user
DATABASE_URL=".../installation_manager_perf" npx prisma migrate deploy
DATABASE_URL=".../installation_manager_perf" npx tsx scripts/perf/seed-large.ts
# Optional, for statement counts: enable pg_stat_statements (shared_preload_libraries) and
#   CREATE EXTENSION pg_stat_statements; in that database.
npm run build && DATABASE_URL=".../installation_manager_perf" npx next start -p 3100
DATABASE_URL=".../installation_manager_perf" BASE_URL=http://localhost:3100 npx tsx scripts/perf/measure.ts out.json
BASE_URL=http://localhost:3100 CPU_THROTTLE=4 npx tsx scripts/perf/browser.ts browser.json
BASE_URL=http://localhost:3100 USERS=20 SECONDS=30 npx tsx scripts/perf/load.ts
```

Notes on the raw data: the baseline browser run's "Dashboard: first feedback" value is not
comparable (the first harness version counted any page heading as feedback); the harness was fixed
before the "after" runs.
