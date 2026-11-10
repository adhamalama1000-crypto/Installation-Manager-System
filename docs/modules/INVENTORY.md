# Inventory

## 1. Module purpose

Know exactly how much of each product (and variant) is in each warehouse, technician vehicle and
bin, where every serial number is, what the stock is worth, and how it got there, with a ledger that
can never be rewritten. The engine was built in the inventory foundation milestone; the full
original design (posting, costing, rules) is in [`docs/INVENTORY.md`](../INVENTORY.md). This page
describes the module as it stands after the ERP upgrade. Related pages: `WAREHOUSES.md`,
`STOCK_DOCUMENTS.md`, `STOCKTAKES.md`, `PRODUCTS.md`.

## 2. How users operate it

- **Stock on hand (`/stock`)**: by product (minimum, low-stock filter, value) or by warehouse and bin;
  CSV export. Technicians see *My van stock*.
- **Stock documents (`/stock/documents`)**: receipts, issues, transfers, returns, adjustments, opening
  balances; draft → post → cancel by reversal (see `STOCK_DOCUMENTS.md`).
- **Stock ledger (`/stock/movements`)**: every movement with filters and CSV.
- **Stocktakes (`/stocktakes`)**: counting a warehouse (see `STOCKTAKES.md`).
- **Serial custody (`/inventory`)**: the older per-serial custody, unchanged.
- **Sales** post their stock issue through the same engine (see `SALES_ANALYTICS.md`).

## 3. Available features

Immutable ledger; balances per product and location; moving average cost; serial locations; three
serial modes (none, optional, required); variants as stock-keeping products; negative-stock policy
per warehouse; documents linked to suppliers, customers and booked visits; stocktakes with freeze;
CSV exports; Excel import of products and opening stock (drafts); availability shown while typing a
document; cost visibility by permission; audit of every change.

## 4. Roles and permissions

| Permission | Allows |
|---|---|
| `inventory.view` | Stock on hand, documents, ledger (technicians: own vehicle only) |
| `inventory.receive` / `inventory.issue` / `inventory.transfer` | Prepare and post those document types |
| `inventory.count` | Stocktakes: start, count, submit; adjustment drafts |
| `inventory.approve` | Approve stocktakes, post adjustments and opening balances, cancel posted documents |
| `inventory.reports` | Costs, stock value, CSV exports |

Admin: all. Warehouse manager: all inventory permissions. Store keeper: view, receive, issue,
transfer, count (no approval, no costs). Accountant: view, reports. Technician: own vehicle (view).
Viewers can be granted read-only inventory permissions.

## 5. Business rules

- Stock changes **only** through posted documents (the posting engine); balances are never edited.
- Ledger rows are never updated or deleted (trigger); a correction is a reversal with a reason.
- No negative stock unless the warehouse allows it; never for serial-tracked products.
- Mandatory serials: one per unit on every line; optional serials: recorded when given, never more
  serials at a location than units (the engine checks).
- A product that has variants never moves stock (trigger); its variants do.
- A warehouse with an open stocktake is frozen for postings.
- Concurrency: shared warehouse locks and exclusive per-product locks (sorted), idempotent requests.

## 6. Database models and relationships

`products`, `units`, `catalog_categories`, `brands`, `warehouses`, `warehouse_bins`,
`stock_balances`, `stock_documents` (+ `supplierId`, `customerId`, `appointmentId` since the upgrade),
`stock_document_lines`, `inventory_movements`, `product_serials`, `document_sequences`, `stocktakes`,
`stocktake_lines`, `suppliers`, `sales_invoices` (→ `stock_documents`). Legacy: `product_models`,
`stock_items`, `stock_movements` (serial custody).

## 7. API routes

`/api/inventory/balances`, `/api/inventory/availability`, `/api/inventory/ledger`,
`/api/inventory/export?kind=balances|ledger`, `/api/stock-documents` (+ `/[id]`, `/post`, `/cancel`),
`/api/stocktakes` (+ actions), `/api/warehouses` (+ bins), `/api/products` (+ variants, images,
import, export), `/api/suppliers` (+ `/[id]`, `/options`), `/api/stock*` (legacy custody).

## 8. Services and important logic

`inventory-posting.ts` (the engine: `postInTx`, `cancelInTx`, optional serials, variant refusal,
`onBehalfOf: "sale"`), `inventory-documents.ts` (drafts, links to supplier / customer / visit,
`documentsForAppointment`), `inventory-stock.ts` (balances, ledger, exports), `stocktakes.ts`,
`inventory-warehouses.ts`, `inventory-common.ts` (locks, sequences, helpers), `suppliers.ts`.

## 9. Validation rules

Quantities > 0, at most three decimals, whole for whole units; costs ≥ 0 with two decimals (four for
unit cost); serial counts per mode; warehouses and bins active; document date not in the future;
reason required for adjustments and cancellations. Shared zod schemas in `src/lib/inventory.ts`.

## 10. Error handling

Posting refuses the whole document with one message per line ("Not enough … available, … needed",
"Serial … is not in this warehouse"); 409 for stale drafts; 403 / 404 by permission and scope; the
database triggers stop anything the services would never do.

## 11. Tests

`tests/integration/inventory.test.ts`, `stocktakes.test.ts`, `inventory-api.test.ts`,
`product-variants.test.ts`, `product-import.test.ts`, `sales.test.ts`, `tests/unit/inventory.test.ts`,
`e2e/inventory.spec.ts`, `e2e/stock.spec.ts`, `e2e/products.spec.ts`, `e2e/import-suppliers.spec.ts`,
`e2e/sales.spec.ts`. Covered: receipts, issues, transfers, returns, adjustments, opening balances,
reversals, negative-stock refusal (also in the database), concurrency, idempotency, serial modes,
stocktakes, variants, import, sales.

## 12. Current limitations

The legacy serial custody is not migrated into the ledger (both run side by side); costing is a
moving average over all warehouses (no FIFO layers); no purchase orders; stocktakes freeze the whole
warehouse.

## 13. Future improvements

Migrating the serial custody into the ledger (needs the owner's mapping decision), purchase orders,
cycle counts, reorder suggestions from minimum stock and sales velocity.
