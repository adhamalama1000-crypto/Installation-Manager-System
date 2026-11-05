# Performance (ERP upgrade)

## 1. Module purpose

Keep the application fast as the ERP features are added, and prove it with measurements on a
production build: navigation, inventory pages, product list / search / detail, reports, APIs and
SQL work. The earlier audit (calendar, round trips, search indexes, compression, prefetch storms) is
in [`docs/PERFORMANCE.md`](../PERFORMANCE.md); this page covers the ERP upgrade.

## 2. How users operate it (how to measure)

```bash
npm run build
PORT=3100 DATABASE_URL=".../installation_manager_perf" npm start          # in one terminal
DATABASE_URL=".../installation_manager_perf" BASE_URL=http://localhost:3100 \
  npx tsx scripts/perf/erp.ts docs/performance/erp-after-1x.json           # server + browser
DATABASE_URL=".../installation_manager_perf" BASE_URL=http://localhost:3100 CPU_THROTTLE=4 SKIP_SERVER=1 \
  npx tsx scripts/perf/erp.ts docs/performance/erp-after-4x.json           # browser at 4x CPU
```

`scripts/perf/seed-inventory.ts` fills a separate database with 3,000 products and about 27,000
stock movements on top of the 33,000-appointment data set of the earlier audit. The script signs in
and issues GET requests only.

**Method used for the numbers below.** Same machine (4 vCPU container), same database
(`installation_manager_perf`, PostgreSQL 16 on the same host), same harness, production builds
(`next build && next start`) of the **baseline** (`main` at `98cd71c`, a separate worktree) and of
this branch, run **back to back on port 3100**. Server: 9 requests per scenario (median and p95),
SQL statements counted with `pg_stat_statements`. Browser: Chromium, 1440×900, clicks through the
sidebar (Dashboard → Stock on hand → Products → a product → Stock documents → Ledger → Warehouses →
Dashboard) 7 rounds, time from the click until the new page's heading is on screen, measured inside
the page. The perf database received this branch's migrations first (all additive; the baseline
build runs unchanged on it).

## 3. Available features (what was improved)

| Change | Where | Effect (measured) |
|---|---|---|
| Removed the inventory pages' `loading.tsx` skeletons: React keeps a Suspense fallback on screen for at least ~300 ms once shown, so every inventory navigation took ~330 ms although the server answered in 30–60 ms. The navigation progress bar already gives instant feedback. | commit `38fe2af` | Click-to-content median **329 → 66 ms** (1x) |
| Per-row links on stock, ledger, documents, stocktakes and warehouse tables no longer prefetch (opening the stock page fired ~30 background renders). | commit `38fe2af` | Background prefetches per navigation: 0 |
| Balances CSV export reads everything in one statement instead of 50 rows per page with a window count each time. | `inventory-stock.ts` | **1,569 → 80 ms**, **61 → 2 SQL statements** |
| Excel import reserves codes in blocks and inserts with `createManyAndReturn`. | `product-import.ts` | 2,000 rows: ~16 s → ~2 s (integration test environment) |
| New reports written as aggregate SQL: sales analytics (one statement per block, all in parallel), work-review queue (latest event per visit in one statement), finance deductions (one grouped statement), penalty scans (existing sources fetched in one query, one advisory lock). | services | Analytics page and new queues stay in single-digit SQL statements |
| Videos streamed with HTTP range requests (not read into memory). | `storage.ts`, attachments route | Constant memory per request |

## 4. Roles and permissions

Not applicable (measurement tooling only; no new permissions). The harness signs in as the seeded
Admin, Warehouse manager and a technician.

## 5. Business rules

- No business data is cached: every page and API reads the database. ETags only avoid re-sending
  unchanged JSON (unchanged since the earlier audit).
- Loading animations are not counted as speed: the timings stop when the real content is on screen.

## 6. Database models and relationships

New tables carry the indexes their queries need: `work_reviews(appointmentId, createdAt)` and
`(event, createdAt)`, `violations(status, occurredOn)` and `(userId, occurredOn)`,
`deduction_entries(month, userId)`, `violation_events(violationId, createdAt)`, unique
`violations.sourceKey`, unique `evidence_rules(visitType, productCategory)`,
`check_ins(relatedAppointmentId)`.

## 7. API routes

Measured: `/api/products` (search, page, picker), `/api/products/[id]`, `/api/inventory/balances`,
`/api/inventory/ledger`, `/api/inventory/availability`, `/api/inventory/export?kind=balances`, and the
pages listed in the results (as full HTML and as the RSC payload of a client navigation).

## 8. Services and important logic

`scripts/perf/erp.ts` (harness), `scripts/perf/seed-inventory.ts` (data), raw results in
[`docs/performance/`](../performance): `erp-before-1x.json` / `erp-before-4x.json` (baseline, morning),
`erp-before-rerun-1x.json`, `erp-before-rerun-4x.json`, `erp-before-rerun2-4x.json` (baseline,
afternoon), `erp-after-1x.json`, `erp-after-4x.json`, `erp-after2-4x.json` (this branch).

## 9. Results

### Browser, no throttling (stable between runs: the baseline measured 327 and 329 ms)

| Step | Before median | After median | Before worst | After worst |
|---|---|---|---|---|
| Dashboard → Stock on hand | 330 ms | 80 ms | 347 ms | 107 ms |
| Stock → Products | 329 ms | 56 ms | 332 ms | 103 ms |
| Products → product detail | 35 ms | 39 ms | 35 ms | 53 ms |
| Product → Stock documents | 330 ms | 65 ms | 330 ms | 70 ms |
| Documents → Stock ledger | 330 ms | 74 ms | 330 ms | 87 ms |
| Ledger → Warehouses | 330 ms | 68 ms | 330 ms | 87 ms |
| Warehouses → Dashboard | 80 ms | 72 ms | 86 ms | 76 ms |
| **All steps** | **329 ms** | **66 ms** | p95 332 ms | p95 97 ms |
| First full load of Stock on hand | 131 ms | 153 ms | | |

### Browser, 4x CPU throttling (noisy: the same baseline build varied 142–227 ms)

| Run | Build | All-steps median | All-steps p95 | First full load | Steps (median ms) |
|---|---|---|---|---|---|
| Morning | Baseline | 227 ms | 443 ms | 443 ms | 364, 191, 129, 186, 255, 231, 443 |
| Afternoon 1 | Baseline | 142 ms | 294 ms | 292 ms | 214, 126, 96, 129, 158, 162, 251 |
| Afternoon 1 | This branch | 168 ms | 281 ms | 408 ms | 266, 162, 112, 155, 164, 194, 253 |
| Afternoon 2 | Baseline | 179 ms | 355 ms | 263 ms | 279, 156, 134, 142, 178, 267, 351 |
| Afternoon 2 | This branch | 168 ms | 254 ms | 336 ms | 239, 156, 108, 136, 200, 160, 214 |

At 4x CPU the run-to-run spread of the **same** build (142–227 ms) is larger than any difference
between the builds; this branch measured 168 ms twice, inside the baseline's range, with better
worst cases (p95 254–281 ms against 294–443 ms). Conclusion: no measurable navigation regression at
4x; the 1x improvement above is real and stable.

### Server (1x, median of 9; SQL statements per request)

| Scenario | Before | After | SQL before → after |
|---|---|---|---|
| page dashboard | 50.5 ms | 45.3 ms | 10 → 11 |
| page stock on hand | 54.6 ms | 46.6 ms | 9 → 9 |
| page stock by warehouse | 71.3 ms | 59.9 ms | 9 → 9 |
| page stock low only | 38.4 ms | 41.9 ms | 9 → 9 |
| page stock documents | 33.1 ms | 34.9 ms | 9 → 9 |
| page stock ledger | 30 ms | 29.3 ms | 12 → 12 |
| page products | 24.2 ms | 28.6 ms | 11 → 12 |
| page products search 'camera' | 25.3 ms | 34.1 ms | 11 → 12 |
| page products search SKU | 25.6 ms | 28.1 ms | 11 → 12 |
| page product detail | 17 ms | 22.9 ms | 14 → 16 |
| page warehouses | 42.2 ms | 47.8 ms | 8 → 8 |
| page warehouse detail | 20.6 ms | 21.7 ms | 8 → 8 |
| page stock document detail | 16.8 ms | 18.3 ms | 13 → 13 |
| page stocktakes | 14.1 ms | 13.6 ms | 7 → 7 |
| page reports (this year) | 63.3 ms | 55.5 ms | 10 → 10 |
| page appointments | 32.1 ms | 33.5 ms | 6 → 6 |
| RSC nav dashboard | 30.7 ms | 30.8 ms | 10 → 10 |
| RSC nav stock on hand | 37.3 ms | 38 ms | 9 → 9 |
| RSC nav stock by warehouse | 50.7 ms | 70.1 ms | 9 → 9 |
| RSC nav stock low only | 31.4 ms | 34.9 ms | 9 → 9 |
| RSC nav stock documents | 25.3 ms | 33.6 ms | 9 → 9 |
| RSC nav stock ledger | 22.3 ms | 26.6 ms | 12 → 12 |
| RSC nav products | 16.1 ms | 23.2 ms | 11 → 12 |
| RSC nav products search 'camera' | 15.4 ms | 29.5 ms | 11 → 12 |
| RSC nav products search SKU | 21.8 ms | 23.2 ms | 11 → 12 |
| RSC nav product detail | 13.9 ms | 14.1 ms | 14 → 16 |
| RSC nav warehouses | 47.3 ms | 49.7 ms | 8 → 8 |
| RSC nav warehouse detail | 15.1 ms | 16.1 ms | 8 → 8 |
| RSC nav stock document detail | 10.2 ms | 11.1 ms | 13 → 13 |
| RSC nav stocktakes | 10.4 ms | 10.5 ms | 7 → 7 |
| RSC nav reports (this year) | 48.4 ms | 55.3 ms | 10 → 10 |
| RSC nav appointments | 24.4 ms | 25 ms | 6 → 6 |
| RSC nav stock (technician van) | 23.1 ms | 25.1 ms | 5 → 5 |
| API products ?q=lock | 14.1 ms | 16.8 ms | 8 → 9 |
| API products page 50 | 12.7 ms | 16.4 ms | 8 → 9 |
| API products picker (warehouse) | 13.6 ms | 14.7 ms | 8 → 9 |
| API product detail | 10.1 ms | 11.2 ms | 11 → 13 |
| API inventory balances | 31.1 ms | 31.1 ms | 3 → 3 |
| API inventory ledger | 13.8 ms | 12.7 ms | 9 → 9 |
| API availability | 6 ms | 6.5 ms | 5 → 5 |
| API balances CSV export | 1569.4 ms | 79.8 ms | 61 → 2 |

How to read it: differences of a few milliseconds are within the run-to-run noise (the same page
varies by ±10–20 %). The real changes are the CSV export (**−95 %**) and one more SQL statement on
product pages (the variants' totals and the product's images), which costs about 2–6 ms there.

### Regressions found, and what was done

- **First full page load +22 ms at 1x (131 → 153 ms)**, stable across runs. Cause: more client code
  for the new features; the largest part is the message dictionary chunk, which contains **both**
  languages (200 KB → 264 KB minified, about 80 KB gzipped) because client code imports the shared
  translator. Splitting the dictionaries per language was implemented and measured as an experiment
  and **reverted**: a provider per language remounts the whole page when the language is switched
  (losing what is typed in an open form, which a test protects), and loading the dictionary as data
  either adds a network round trip before the page is interactive or resends the dictionary with
  every page refresh after a save. The chunk is cached by the browser between visits (immutable
  file name), so the cost is mainly parsing on a full page load.
- **Product pages +1 SQL statement** (variants and images): +2–6 ms median, accepted for the feature.

## 10. Error handling

Not applicable. The harness stops with the HTTP status when a page does not answer 200.

## 11. Tests

Performance is measured, not unit-tested. The correctness of the optimised paths is covered by the
module tests: `tests/integration/inventory-api.test.ts` (balances CSV), `product-import.test.ts`
(thousands of rows in one transaction), `sales.test.ts` (analytics figures), `evidence.test.ts`
(review queue), `penalties.test.ts` (scans, concurrency, finance totals). The phone-width sweeps
(`e2e/responsive.spec.ts`, `e2e/arabic.spec.ts`) load every page, including the new ones.

## 12. Current limitations

- Both languages' messages are sent to every browser (see above).
- The 4x CPU numbers are noisy on this shared machine; small differences there are not meaningful.
- Server rendering CPU remains the limit under heavy concurrent use (see the earlier audit).
- The perf data set is synthetic.

## 13. Future improvements

- Per-language dictionaries without remounting (for example, language in the URL so each language
  has its own layout).
- Measure on a copy of production data and with the database at its real network distance.
- A nightly automated run of the harness with alerts on regressions.
