# Excel import and export

## 1. Module purpose

Load and update the catalogue (thousands of rows, with variants) and opening stock from an Excel
file, safely: preview first, see every problem with its row and column, then import in one
transaction. Export the catalogue in the same format for editing and re-import. The CSV exports of
stock balances and the ledger remain.

## 2. How users operate it

Products → *Import* (`/products/import`):

1. *Download template* (`.xlsx`, English and Arabic headers, hints, example rows; a *Products* sheet
   and an optional *Opening stock* sheet).
2. Choose the file and options: *Update existing products* (an existing SKU updates the product),
   *Create missing categories and brands*, *Import valid rows even if some rows have errors*.
3. *Preview*: a summary (to create, to update, to skip, errors) and a table of rows with the
   action and each problem with its column.
4. *Import*: the same checks run again inside one transaction; the result lists what was done and
   the opening-stock drafts created.

Opening stock rows become **draft opening-balance documents** (one per warehouse) to review and
post as usual; nothing is posted by the import. Products → *Export* downloads the catalogue in the
template's format.

## 3. Available features

Template download; header matching by key, English or Arabic label (case, spaces, `*` and
punctuation ignored; unknown columns ignored); automatic SKUs and variant codes (including codes
that later rows of the stock sheet can refer to); internal barcodes on request; variants by
`parent_sku` (in the system or earlier in the file); serial mode words (`NONE` / `OPTIONAL` /
`REQUIRED`, also no / optional / yes); duplicate detection inside the file and against the system;
errors per row and column; all-or-nothing import unless *skip invalid* is chosen; up to 10,000 rows
and 10 MB; export for re-import.

## 4. Roles and permissions

Import and template: `products.manage` (Admin, Warehouse manager). Export: `products.view` (costs
included only for people who may see costs). Balances / ledger CSV: `inventory.reports`.

## 5. Business rules

- Preview never writes. Commit re-validates everything (the file could have changed).
- One transaction: with errors and without *skip invalid*, nothing is written.
- Existing SKUs are skipped unless *update* is on; updates follow the same product rules as the form
  (unit and serial mode locked after movements).
- Opening stock creates drafts only; posting them goes through the normal posting engine with its
  checks (warehouse frozen by a stocktake, serials, whole units).
- Codes are reserved in blocks for speed; typed codes in the file are reserved first so generated
  ones never collide with them.

## 6. Database models and relationships

Writes `products` (and variants), `catalog_categories` and `brands` (when creating missing ones),
`stock_documents` / `stock_document_lines` (opening-balance drafts), `document_sequences`,
`audit_logs` (one entry per import with counts). No new tables.

## 7. API routes

`GET /api/products/import/template`, `POST /api/products/import?mode=preview|commit&update=1&createMissing=1&skipInvalid=1`
(raw `.xlsx` body; each option is off unless set to `1`), `GET /api/products/export`, `GET /api/inventory/export?kind=balances|ledger` (CSV).

## 8. Services and important logic

`src/lib/product-import.ts` (columns, header matching, value parsing; no Excel library, shared with
the browser), `src/server/services/product-import.ts` (`readWorkbook` with ExcelJS, `previewImport`,
`commitImport`, `importTemplate`, `exportProductsXlsx`), `src/components/erp/product-import.tsx`.
Performance: the first version took about 16 s for 2,000 rows; batching code reservations and
`createManyAndReturn` brought it to about 2 s (measured in the integration test environment).

## 9. Validation rules

Required columns per row type (product: names and unit; variant: parent and variant names; stock:
SKU, warehouse, quantity); numbers with at most two decimals (quantities three, whole for whole
units); valid serial mode; colours `#RRGGBB`; serial count matching the quantity for mandatory
serials; references (category, brand, unit, warehouse, bin, parent) must exist or be creatable.

## 10. Error handling

A file that is not a valid `.xlsx`, too large or with too many rows is refused with the reason.
Row problems are returned as `{ sheet, row, sku, name, action, messages: [{ field, message }] }`
and shown in the reader's language.

## 11. Tests

`tests/integration/product-import.test.ts` (7): template round trip, preview without writes, codes on
commit, variants and opening drafts, duplicates / unknown references / bad values with row and
column, Arabic headers and rights, **thousands of rows in one transaction** and export for
re-import. `e2e/import-suppliers.spec.ts`: preview with row errors and import of valid rows by the
warehouse manager.

## 12. Current limitations

Only the product catalogue and opening stock are imported (not customers, suppliers or historical
documents); images are not imported; very large files are processed in one request (no background
job).

## 13. Future improvements

Background import with progress for files above 10,000 rows; customer and supplier imports; image
import from URLs or a ZIP.
