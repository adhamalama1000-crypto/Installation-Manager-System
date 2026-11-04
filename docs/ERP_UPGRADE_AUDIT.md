# ERP upgrade: system audit (November 2026)

Audit done before the ERP upgrade on branch `claude/kind-galileo-lewq66`, starting from `main` at
`98cd71c` (merge of #16). It was done by reading the source, the Prisma schema and all 19
migrations, the services and API routes, the tests and the existing documentation, and by running
the checks on a fresh copy of the database. Nothing in this table was assumed from the user
interface alone.

**Baseline checks (run before any change):** `npm run lint` no errors · `npm run typecheck` no
errors · `npm test` **31 files, 245 / 245 passed** · `prisma migrate deploy` applied all 19
migrations to a new database · `npm run db:seed` succeeded.

**Database used here:** a local PostgreSQL 16 in this environment, migrated from the repository's
migrations and filled with the demo seed (and, for the performance work, a separate `_perf`
database with 33,000 appointments and 3,000 products). The production database is not reachable
from this environment, so "existing data preserved" is verified by the migration rules below and by
row counts on these databases, not on production data.

## Safe database strategy

- Every schema change is a **new, additive migration**: new tables, new nullable columns or columns
  with a constant default (metadata-only in PostgreSQL 11+, so existing rows are not rewritten and
  no `UPDATE` trigger fires), new enum values in their own migration, new indexes.
- No `DROP TABLE`, no `DROP COLUMN`, no `migrate reset`, no `db push --accept-data-loss`, no
  `SEED_FORCE`. The append-only triggers on the ledger, audit log, check-ins and attachments are
  kept; where a guard function must also protect a new column it is replaced with
  `CREATE OR REPLACE FUNCTION`, never dropped.
- Historical stock movements, posted documents, audit rows, check-ins and attachments are never
  updated. Data that belongs to a new feature is written to new tables.
- Each migration states at its top what it changes and how to roll it back.

## Feature matrix

Status values: **Working** (implemented and working), **Improve** (implemented, needs improvement),
**Partial**, **Missing**, **Broken**, **Verify** (requires verification).

| # | Module | Status | What exists (evidence) | What the upgrade does |
|---|---|---|---|---|
| 1 | Authentication and user management | Working | bcrypt, hashed session tokens, DB rate limiting, invitation and reset links, last-Admin protection (`src/server/auth/*`, `services/users.ts`, tests `auth-cookies`, `admin-password`, `users-audit-reports`) | Keep; fix the login form (row 1a) |
| 1a | Password visibility toggle | **Broken** | The eye button exists (`login-form.tsx`) but: in the Arabic (RTL) layout the button is placed by the page direction (left) while the input is `dir="ltr"` and reserves its padding on the right, so the icon covers the first characters of the password; clicking it moves focus out of the field and the caret is lost; no `aria-pressed`; the set-password and change-password forms have no toggle | Shared `PasswordInput` used by all three forms; focus and caret kept; RTL-safe; keyboard accessible |
| 2 | Roles and permissions | Working | One pure permission table (`lib/permissions.ts`) enforced in every service (`server/access.ts`); 8 roles; Viewer grants; tests `permissions.test.ts` | Add permissions for the new modules; document the full matrix |
| 3 | Dashboard and analytics | Working | Counters in one statement, needs-attention list, readiness warnings (`services/dashboard.ts`); appointment reports | Add sales analytics (row 12) and attendance alerts |
| 4 | Products and product variants | **Partial** | Catalogue with names, SKU, barcode, category, brand, unit, costs, min stock, warranty, serial flag (`inventory-catalog.ts`). **No variants**, no product images | Variants, images, product copy |
| 5 | SKU and barcode generation | **Missing** | SKU and barcode are typed by hand and checked for uniqueness only | Automatic, concurrency-safe SKU and variant codes; internal EAN-13 barcodes on request |
| 6 | Inventory and stock ledger | Working | Immutable ledger, per-location balances, moving average, triggers (`inventory-posting.ts`, migration `20261101120100`) | Keep the engine; add variant and optional-serial support without changing history |
| 7 | Warehouses and storage locations | Working | Warehouses, vans, bins, negative-stock policy (`inventory-warehouses.ts`) | Keep |
| 8 | Stock receipts and issues | Improve | Documents with draft/post/reverse; supplier is free text; issues are not linked to visits | Supplier master and visit link on documents |
| 9 | Transfers and returns | Working | Transfers between warehouses and bins, customer and supplier returns | Keep |
| 10 | Stocktaking | Working | Snapshot, freeze, counts with serials, approval into one adjustment | Works per product; variants are products, so variant counts come for free |
| 11 | Excel import/export | **Missing** | CSV export of balances and ledger only; no import | `.xlsx` template, preview, validation, import, export |
| 12 | Sales and sales analytics | **Missing** | No sales records. Appointments carry an agreed price; stock issues are not sales | Sales invoices (confirmed sales only) that post their stock issue; analytics from confirmed sales only |
| 13 | Customers and suppliers | Partial | Customers and sites exist (created from bookings, list and detail, look-up); no supplier master | Supplier master; customers reused by sales |
| 14 | Appointments and installations | Working | Booking, double-booking prevention (advisory locks + exclusion constraint), outcomes, delivery proof | Keep; evidence rules (row 17) |
| 15 | Technician management | Working | Users with specialty, leave, live board, points | Keep; attendance dashboard |
| 16 | Attendance and GPS tracking | Improve | Check-ins with browser GPS, accuracy, distance, far flag (fixed 400 m / 300 m), late / early minutes, monthly attendance (`services/field.ts`); append-only trigger. **No selfie, no work locations, radii not configurable, check-in only at the company, missing check-out not detected, no review of flagged check-ins, monthly view only** | Clock-in / clock-out at the company, a customer site or an approved work location with live-camera selfie; configurable geofences; missing check-out; review; daily, weekly and monthly reports |
| 17 | Work evidence and attachments | Improve | Before/after photos, signature, transfer proofs, delivery checklist, optional "proof required" setting (`services/attachments.ts`, `lib/delivery.ts`). Images only; one global rule; no review | Evidence rules per visit type, video, completion notes, submit / approve / reject / resubmit with audit |
| 18 | Penalties and deductions | **Missing** | Only monthly points (deductions of points, not money) | Configurable rules, proposed violations, approval workflow, finance entries only after approval |
| 19 | Expenses and finance | Partial | Transport expenses with receipts and payout; monthly finance statement and cash custody | Approved deductions shown in finance; sales in finance |
| 20 | Notifications and audit history | Working | In-app notifications; append-only audit log with field-level changes | Use for every new action |
| 21 | Data entry experience | Improve | Zod validation shared by browser and server; customer look-up while booking; product search in documents | Searchable pickers, "save and add another", copy product, drafts kept while typing, defaults from the chosen record |
| 22 | Application performance | Verify | Earlier work measured appointment pages (`docs/PERFORMANCE.md`); **the inventory pages were never measured** | Measure the ERP pages before and after on a production build with 3,000 products and 27,000 movements |
| 23 | Arabic RTL and English | Working | Arabic first, full dictionaries with a parity test, RTL layout tests | Every new text in both languages |
| 24 | Mobile responsiveness | Working | Overflow sweeps at 320–1024 px in e2e tests | New pages in the sweeps |
| 25 | Documentation and testing | Improve | README, INVENTORY.md, PERFORMANCE.md, 245 tests, 33 e2e tests | `docs/modules/*` per module, Arabic user guide, tests for every change |

## Existing serial custody vs. the new ledger

Two serial systems exist side by side:

- **Legacy serial custody** (`product_models`, `stock_items`, `stock_movements`, `/inventory`):
  each serial is in the store, with a technician, installed at a visit (with warranty), returned or
  faulty. The visit outcome installs serials from it.
- **ERP ledger** (`products`, `product_serials`, `inventory_movements`, `/stock`): quantities per
  location, serial locations for serial-tracked products.

They are not merged automatically, because each legacy model must be matched to a catalogue
product by someone who knows the stock (the earlier phase recorded this as needing the owner's
decision). The upgrade keeps both working and **links the ledger to visits**: a stock issue can
name the visit it is for, so material used on site is traceable from the visit and from the ledger,
without a second tracking system.
