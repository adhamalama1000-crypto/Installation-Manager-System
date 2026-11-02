# ERP inventory foundation (phase 1)

The first ERP milestone: a product catalogue, warehouses (including technicians' vehicles) with
bins, an immutable stock ledger with per-location balances, numbered stock documents, physical
stocktaking, and the permissions and Warehouse Manager role to run them. Everything else in the
system (booking, scheduling, technicians, GPS, attendance, delivery proof, after-sales, the
serial custody) works as before.

- [Scope](#scope)
- [Entities](#entities)
- [How a posting works](#how-a-posting-works)
- [Stock rules](#stock-rules)
- [Permissions and roles](#permissions-and-roles)
- [Pages and API](#pages-and-api)
- [Deploying the migrations](#deploying-the-migrations)
- [Setting up a live company](#setting-up-a-live-company)
- [Workflow examples](#workflow-examples)
- [Testing](#testing)
- [Known limitations](#known-limitations)

## Scope

| Included | Not in this phase |
|---|---|
| Products: Arabic and English names, SKU, barcode, category and subcategory, brand, model, description, unit, purchase cost, selling price, minimum stock, warranty, serial tracking, active flag | Suppliers and purchase orders (receipts carry the supplier as text) |
| Units of measure (Piece, Meter, Box, Set, Roll seeded; more can be added), categories (two levels), brands | Sales orders, invoices, price lists |
| Warehouses and technicians' vehicles, bins, a negative-stock policy per warehouse | Issuing stock against a booked visit (an issue carries the visit code as a reference) |
| Immutable ledger, balances per product and location, moving average cost, serial locations | Moving the legacy serial custody (`stock_items`) into the ledger |
| Goods receipt, issue, transfer, customer and supplier return, adjustment, opening balance; draft → posted → cancelled by reversal | Accounting entries (journal) for stock value |
| Stocktakes: snapshot and freeze, counts (with serials), explanations, submission, approval into one adjustment, rejection | Cycle counts of part of a warehouse |

## Entities

All tables are new (migration `20261101120100_inventory_foundation`); none of the existing tables
changed. The `WAREHOUSE_MANAGER` role value is added by `20261101120000_role_warehouse_manager`.

| Table | Purpose |
|---|---|
| `units` | Unit of measure. `allowsFraction` says whether quantities may have decimals (3 at most). |
| `catalog_categories` | Category; one with a `parentId` is a subcategory (two levels). Products point at the most specific one. |
| `brands` | Brand names, unique regardless of case. |
| `products` | The catalogue. `sku` unique (capitals), `barcode` unique when given, `averageCost` kept by the posting engine, `version` for optimistic locking. Never deleted (deactivated). |
| `warehouses` | A place that holds stock. `kind` = `WAREHOUSE` or `VEHICLE`; a vehicle belongs to one technician (`technicianId`, unique). `allowNegative` is the negative-stock policy (off by default). |
| `warehouse_bins` | Shelves / bins inside a warehouse, codes unique per warehouse. Stock may also sit in a warehouse without a bin. |
| `stock_balances` | On-hand quantity per product and location (warehouse, or one of its bins). `binKey` is the bin id or `""`, so the location is unique. Written only by the posting engine. |
| `stock_documents` | A numbered document (`GRN-2026-000001` …): type, status, source and destination warehouses, business date, reference, supplier/customer, note, who created / posted / cancelled it and when, the cancel reason, `clientRequestId` for safe retries, and the stocktake it came from. |
| `stock_document_lines` | Product, quantity, unit cost (for stock coming in), bins, adjustment direction, serial numbers, reason. |
| `inventory_movements` | The ledger: one row per product per location change, with the signed quantity, cost used, serials, reason, the warehouse total right after (`balanceAfter`), who and when, and for a reversal the movement it reverses. |
| `product_serials` | Where each serial number of a serial-tracked product is now (`warehouseId` empty = not in stock) and the last movement that moved it. |
| `document_sequences` | Number counters per prefix and year (`GRN-2026`). |
| `stocktakes` / `stocktake_lines` | A count of one warehouse: the snapshot (system quantity and serials per product and bin), what was counted, explanations, and who started, counted, submitted and decided. |

Document numbers: `OB` opening balance, `GRN` goods receipt, `ISS` issue, `TRF` transfer, `RTN`
return, `ADJ` adjustment, `STK` stocktake; then the year of the document date and six digits. The
number is assigned when the draft is created; a cancelled draft keeps its number (gaps are visible
in the audit log).

## How a posting works

Posting (`src/server/services/inventory-posting.ts`) runs in one database transaction:

1. Lock the document row (`SELECT … FOR UPDATE`). A document that is already posted is left as it
   is and the call succeeds (a repeated click or retry moves the stock once); a cancelled one is
   refused.
2. Check the poster's permission for the document type.
3. Take a **shared** advisory lock on each warehouse of the document, then refuse if a stocktake is
   open on one of them (the stocktake takes the same lock **exclusively** while it starts and closes).
4. Re-check that the warehouses, bins and products are still active.
5. Take an **exclusive** advisory lock per product (sorted, so two postings never wait on each other
   in a circle), then read the current balances, serial locations and average costs.
6. Work out every movement in order (a transfer line is "out" then "in"), checking availability per
   location, serial locations, and whole quantities for whole units. Any problem refuses the whole
   document with a message per line; nothing is written.
7. Update the balances, insert the movements (with `balanceAfter`), move the serials, update the
   moving average costs, mark the document posted, and write the audit entry.

Cancelling a posted document (`cancelInTx`) takes the same locks and writes one `REVERSAL`
movement per original movement, newest first, with the same checks: a receipt whose stock has
already been issued cannot be reversed (the message says which product is short).

The database is the last line of defence (triggers and constraints, see below), so even a bug or a
manual SQL statement cannot break the ledger's rules.

### Costing

Moving average per product over all warehouses:

- Stock coming in at a cost (receipt, opening balance, customer return, adjustment increase)
  updates it: `(on hand × average + quantity × cost) / (on hand + quantity)`. A receipt line
  without a cost uses the product's purchase cost; with neither, the document is refused. Returns
  and adjustments without a cost come in at the current average.
- Stock going out and transfers leave it unchanged and are valued at the current average.
- Reversing a costed receipt takes its quantity and cost back out of the average; reversing an
  outgoing movement brings it back in at the cost it left with.

Costs (purchase cost, average cost, unit costs, stock value) are shown only to people with
`inventory.reports`, `products.manage` or `inventory.approve`. People who may not see costs never
receive them from the API; when they edit a draft, the costs already on it are kept.

## Stock rules

| Rule | Where it is enforced |
|---|---|
| No negative stock, unless the warehouse allows it; never for serial-tracked products | Posting engine (friendly message per line) and the `stock_balances_guard` trigger |
| Ledger rows are never updated or deleted | `inventory_movements_no_update_delete` trigger |
| A document changes only while it is a draft; afterwards only *posted → cancelled*; never deleted | Service checks and the `stock_documents_guard` / `stock_document_lines_guard` triggers |
| Corrections are reversals (with a reason, by an approver) | `cancelInTx`; CHECK: a cancelled posted document has a reason |
| A product's unit and serial tracking are fixed once stock has moved; products are never deleted | Service checks and the `products_guard` trigger |
| A product is deactivated only when it has no stock left (documents refuse inactive products) | Product service; inactive products that still hold stock stay listed in stock on hand |
| The ledger lists the movements of one posting in the order they were written (a transfer's "out" before its "in") | Movement ids sort by posting time and position |
| Pages refuse users without access with a real redirect, before anything is streamed | A layout per section (`products`, `warehouses`, `stock`, `stocktakes`); loading skeletons wrap only the list pages |
| Quantities: more than zero, at most three decimals, whole numbers for whole units; serial-tracked lines have exactly one serial per unit | Shared zod schemas, service checks, CHECK constraints |
| Which warehouses each document type uses | Shared schema and the `stock_documents_warehouses_check` constraint |
| One open stocktake per warehouse; the warehouse is frozen while it is open | Stocktake service under an exclusive warehouse lock; posting refuses frozen warehouses |
| A closed stocktake never changes; the snapshot of a line never changes; counts only while counting | `stocktakes_guard` and `stocktake_lines_guard` triggers |
| Only a vehicle belongs to a technician, one vehicle per technician | CHECK `warehouses_technician_check` and a unique index |
| Duplicate submissions | `clientRequestId` (unique) on create; idempotent post, cancel and approve |
| Every change is audited (who, what, when) | `recordAudit` with entity types `PRODUCT`, `WAREHOUSE`, `INVENTORY`, `STOCKTAKE` |

## Permissions and roles

New permissions (all checked on the server in every service function):

| Permission | Allows |
|---|---|
| `products.view` / `products.manage` | See / create and edit products, units, categories, brands |
| `warehouses.view` / `warehouses.manage` | See / create and edit warehouses, vehicles, bins and the negative-stock policy |
| `inventory.view` | Stock on hand, stock documents and the ledger (technicians: their own vehicle only) |
| `inventory.receive` | Goods receipts and customer returns (prepare and post) |
| `inventory.issue` | Issues and supplier returns (prepare and post) |
| `inventory.transfer` | Transfers between warehouses and bins (prepare and post) |
| `inventory.count` | Start and count stocktakes, submit them, prepare adjustment drafts |
| `inventory.approve` | Approve or reject stocktakes, post adjustments and opening balances, cancel posted documents |
| `inventory.reports` | Costs, stock value and the CSV exports |

| Role | Inventory permissions |
|---|---|
| Admin | all |
| **Warehouse manager** (new) | all of the above, plus the serial custody (`stock.view`, `stock.manage`) and appointments read-only |
| Store keeper | products and warehouses (read), stock, receive, issue, transfer, count (no approval, no costs), plus the serial custody as before |
| Accountant | products and warehouses (read), stock, costs and exports |
| Sales | products (read) |
| Technician | stock of their own vehicle (read) |
| Driver | none |
| Viewer | can be granted `products.view`, `warehouses.view`, `inventory.view`, `inventory.reports` (read only) |

Preparing and posting are separate where it matters: a store keeper can draft an adjustment after
a count, but only an approver can post it.

## Pages and API

Pages (sidebar group "Inventory"; the old "Inventory" entry, the serial custody, is now called
"Serial custody"):

| Page | What it does |
|---|---|
| `/stock` | Stock on hand by product (with minimum and low-stock filter) or by warehouse and bin; value at average cost; CSV. Technicians: "My van stock". |
| `/stock/documents`, `/stock/documents/new?type=…`, `/stock/documents/[id]`, `/stock/documents/[id]/edit` | Documents list with filters; new document with product search, availability, bins, serials and costs; detail with post, cancel draft and cancel by reversal (each confirmed). |
| `/stock/movements` | The ledger with filters (product, warehouse, type, dates, document / SKU / serial search) and CSV. |
| `/stocktakes`, `/stocktakes/[id]` | Start a count; the count sheet (system, counted, difference, explanation; serials), add a product found, submit, approve, reject, cancel. |
| `/products`, `/products/new`, `/products/[id]`, `/products/setup` | Catalogue with search, filters, sorting and pagination; product form; stock by warehouse; units, categories and brands. |
| `/warehouses`, `/warehouses/[id]` | Warehouses and vehicles, value, open stocktake; bins. |

API (JSON; same session, origin and permission checks as the rest of the app):

| Endpoint | Methods |
|---|---|
| `/api/catalog/units`, `/api/catalog/units/[id]` | GET, POST / PATCH |
| `/api/catalog/categories`, `/api/catalog/categories/[id]` | GET, POST / PATCH |
| `/api/catalog/brands`, `/api/catalog/brands/[id]` | GET, POST / PATCH |
| `/api/products`, `/api/products/[id]` | GET (search, filters, sort, page, `warehouseId` for availability), POST / GET, PATCH |
| `/api/warehouses`, `/api/warehouses/[id]`, `/api/warehouses/[id]/bins`, `/api/warehouses/[id]/bins/[binId]` | GET, POST / GET, PATCH / POST / PATCH |
| `/api/stock-documents`, `/api/stock-documents/[id]` | GET, POST (`post: true` posts at once) / GET, PATCH (drafts) |
| `/api/stock-documents/[id]/post`, `/api/stock-documents/[id]/cancel` | POST |
| `/api/inventory/balances`, `/api/inventory/availability`, `/api/inventory/ledger` | GET |
| `/api/inventory/export?kind=balances|ledger` | GET (CSV, `inventory.reports`) |
| `/api/stocktakes`, `/api/stocktakes/[id]` | GET, POST / GET |
| `/api/stocktakes/[id]/counts`, `/lines`, `/submit`, `/approve`, `/reject`, `/cancel` | POST |

## Deploying the migrations

Both migrations are additive: new enum types, new tables, indexes, constraints and triggers, five
rows in the new `units` table, and one new value in the `Role` enum. No existing table, column or
row is changed.

1. Back up the database (as for any release).
2. `npx prisma migrate deploy`. Never `migrate reset` or `db push --accept-data-loss`.
3. `npx prisma migrate status` should report the database up to date.
4. Deploy the application.

The new role value is in its own migration because PostgreSQL cannot use an enum value in the
transaction that adds it. Rollback steps are at the top of each migration file (they drop the new
tables, which removes all inventory data, so they are for a release that never went live).

`pg_trgm` is already enabled by `20261025200000_search_indexes`; the migration repeats
`CREATE EXTENSION IF NOT EXISTS` harmlessly.

## Setting up a live company

Nothing is created automatically for existing employees. In order:

1. Users → give the person running the stores the **Warehouse manager** role.
2. Products → *Units, categories & brands*: check the units, add categories and brands.
3. Products → add the products (or ask for an import script, see limitations).
4. Warehouses → add the main store and its bins; then, for each technician who carries stock, a
   **vehicle** linked to that technician.
5. Stock documents → *Opening balance* per warehouse with the counted quantities and costs (serial
   numbers for serial-tracked products), posted by the warehouse manager.
6. From then on, every movement goes through documents; count each warehouse regularly with a
   stocktake.

The serial custody (`/inventory`) keeps working for the serial numbers already registered there.
It is separate from the new ledger; moving it over is a later step (see limitations).

## Workflow examples

- **Goods arrive from a supplier**: New document → Goods receipt → main store, supplier name and
  invoice number as reference, lines with quantities (serials for locks) and costs → *Save and
  post*. Balances, average costs and serial locations update at once.
- **Loading a technician's van**: Transfer from MAIN (bin A-01) to VAN-KARIM with the lock serials
  → post. Karim sees them under *My van stock*.
- **Material used on a site**: Issue from the van, with the visit code as reference → post. If more
  is issued than the van holds, the document is refused with "Not enough … available, … needed".
- **Customer brings a lock back**: Return → *From a customer* into the main store with the serial.
  **Faulty unit back to the supplier**: Return → *To a supplier* out of the main store.
- **Damaged cable**: the store keeper prepares an Adjustment (decrease, reason "Damaged"); the
  warehouse manager reviews and posts it.
- **A receipt was posted twice by mistake**: the warehouse manager opens the second one → *Cancel
  by reversal* with the reason. The document and its movements stay; reversal movements bring the
  stock back.
- **Monthly count**: Stocktakes → start for MAIN (it is frozen from now on) → count each line
  (serials for locks), explain differences → submit → the warehouse manager approves: one
  adjustment document (`ADJ-…`) is posted for all differences and MAIN is unfrozen.

## Testing

```bash
npm test                    # all unit and integration tests (TEST_DATABASE_URL is wiped)
npx vitest run tests/integration/inventory.test.ts tests/integration/stocktakes.test.ts \
  tests/integration/inventory-api.test.ts tests/unit/inventory.test.ts
npm run build && npm start  # against a freshly migrated and seeded database
E2E_BASE_URL=http://localhost:3000 npx playwright test e2e/inventory.spec.ts
```

Covered: product creation and validation, SKU and barcode uniqueness, units fixed after movements,
categories (two levels, unique names), search / filter / pagination; warehouses and vehicles (one per
technician, no automatic vehicles), bins, deactivation only when empty; receipts with average cost
and serials; issues and the refusal of negative stock (also directly in the database), the
per-warehouse negative policy; whole and fractional units; transfers between warehouses and bins
with serials; customer and supplier returns; adjustments prepared by the store and posted only by an
approver; opening balances; draft editing, stale edits, future dates; immutability of movements and
posted documents (triggers); reversal restoring balances, serials and average cost, refused when
the stock has moved on; concurrency (simultaneous issues of the last units, simultaneous receipts);
duplicate requests (same `clientRequestId`, double post); stocktakes (snapshot with serials, freeze,
partial counts, explanations, approval into one adjustment, serial swaps, products found during
the count, rejection, cancellation, idempotent approval, the audit trail); access by role (vehicle
scoping, cost visibility, viewers, store vs manager); the API (401, 403, 422 in Arabic and English,
idempotent create and post, CSV); Arabic and English pages, RTL, and no horizontal scrolling at
390 px on every new page.

## Known limitations

- The legacy serial custody (`product_models`, `stock_items`, `stock_movements`) is not migrated into
  the new ledger; the two run side by side. A one-time import (each legacy model as a product, each
  in-store / with-technician serial as an opening balance in the main store / the technician's van)
  is the planned next step and needs the owner's decision on mapping.
- Suppliers and customers on documents are free text until the purchasing and sales milestones add
  their masters; issues are not yet linked to booked visits (use the visit code as the reference).
- A stocktake freezes the whole warehouse until it is closed; partial (cycle) counts are not
  supported yet.
- Costing is a moving average over all warehouses; reversals adjust it approximately when stock has
  moved in between (exact FIFO layers are out of scope).
- No bulk import of products yet (the catalogue is entered in the UI or through the API).
- Document numbers come from `document_sequences`; a transaction that fails after taking a number
  rolls it back, but a draft that is created and then cancelled keeps its number.
