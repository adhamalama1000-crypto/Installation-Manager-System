# Products

## 1. Module purpose

The product catalogue used by stock, sales, stocktakes and analytics: smart locks, smart-home
devices, CCTV, RFID, intercoms, access control, low-current materials, cables and accessories. The
catalogue existed before the upgrade (`src/server/services/inventory-catalog.ts`); the upgrade added
automatic codes, variants, optional serial numbers, internal barcodes, images, category codes and
faster data entry, without changing how stock moves.

## 2. How users operate it

- **Products (`/products`)**: search (name, SKU, barcode, variant code), filters (category, brand,
  active, serial mode, low stock), sorting, pages; the list shows variants' total stock.
- **New product (`/products/new`)**: names (English / Arabic), category (searchable), brand
  (searchable), model, unit, purchase cost, selling price, minimum stock, warranty, serial numbers
  (*None*, *Optional*, *Required*), barcode or *Generate barcode*, description, active. The SKU can
  be left empty: it is generated on save. *Save and add another* keeps category, brand, unit and
  serial mode for the next product; a draft of an unsaved form is kept in the browser. *Copy* on a
  product opens a new form pre-filled from it (without codes).
- **Product page (`/products/[id]`)**: details, stock per warehouse and bin, variants, images (up to
  8, first one is the main image), barcode with its printable symbol, edit.
- **Setup (`/products/setup`)**: units, categories (two levels, optional SKU prefix code) and brands.
- Import and export: see `EXCEL_IMPORT_EXPORT.md`. Variants: see `PRODUCT_VARIANTS.md`. Codes: see
  `SKU_AND_BARCODE.md`.

## 3. Available features

Arabic and English names; automatic SKU per category prefix; internal EAN-13 barcodes; serial mode
none / optional / required; variants; images (JPEG / PNG / WebP by their bytes, 8 per product);
minimum stock and low-stock filter; moving average cost (kept by the posting engine); optimistic
locking (`version`); deactivation instead of deletion; audit of every change.

## 4. Roles and permissions

`products.view` (Admin, Sales, Accountant, Store keeper, Warehouse manager; grantable to Viewers)
to see; `products.manage` (Admin, Warehouse manager) to create and edit products, variants, images,
units, categories, brands and to import. Costs (purchase cost, average cost) only for people with
`inventory.reports`, `products.manage` or `inventory.approve`; others never receive them.

## 5. Business rules

- SKU unique (stored in capitals); barcode unique when given.
- Unit and serial mode are fixed once stock has moved, except relaxing *Required* to *Optional*
  (every recorded serial stays valid); the database trigger `products_guard` enforces this.
- Products are never deleted; a product is deactivated only when it holds no stock.
- History is never rewritten: editing a product's name or price does not change past documents,
  movements or sales lines (they keep their own quantities, costs and prices).
- A product with variants holds no stock itself (database trigger).

## 6. Database models and relationships

`products` (with `parentId`, `hasVariants`, `variantNameEn/Ar`, `colorHex`, `trackSerials`,
`serialsOptional`, `averageCost`, `version`), `units`, `catalog_categories` (`parentId`, `code`),
`brands`, `product_images` (file key, type, size, hash, position; removal marks the row),
`stock_balances`, `product_serials`. Migrations `20261101120100_inventory_foundation` (existing) and
`20261105090000_product_variants` (additive).

## 7. API routes

`GET/POST /api/products`, `GET/PATCH /api/products/[id]`, `/api/products/[id]/variants` (GET, POST),
`/api/products/[id]/variants/[variantId]` (PATCH), `/api/products/[id]/variants/attach` (POST),
`/api/products/[id]/detach` (POST), `/api/products/[id]/images` (GET, POST raw bytes),
`/api/product-images/[id]` (GET, DELETE), `/api/product-images/[id]/first` (POST),
`/api/catalog/units|categories|brands` (+ `/[id]`), `/api/products/import`, `/api/products/import/template`,
`/api/products/export`.

## 8. Services and important logic

`inventory-catalog.ts` (`listProducts`, `getProduct`, `saveProduct`, catalogue lists),
`product-codes.ts` (codes), `product-variants.ts`, `product-images.ts`, `src/lib/inventory.ts`
(`productSchema`, `SERIAL_MODES`, `serialModeOf`, `serialFlags`), `src/lib/product-codes.ts`.
UI: `src/components/erp/product-form.tsx`, `variants-panel.tsx`, `product-images.tsx`, `barcode.tsx`.

## 9. Validation rules

Names required (≤ 200); SKU optional, letters / digits / `-` `_` `.` (≤ 64); barcode digits / letters
(EAN-13 check digit verified when 13 digits); prices ≥ 0 with two decimals; minimum stock ≥ 0;
warranty 0–120 months; colour `#RRGGBB`; category code 2–6 capitals / digits starting with a letter.

## 10. Error handling

422 with field messages (duplicate SKU or barcode names the other product); 409 / stale-record
message when someone else saved the product first (optimistic locking); 403 without
`products.manage`; images of the wrong type or over the limit are refused with the reason.

## 11. Tests

`tests/integration/product-variants.test.ts` (14 tests: automatic SKU, skipping hand-typed numbers,
12 concurrent creations with distinct SKUs, internal barcodes, rights, variants, serial modes,
stocktakes), `tests/unit/product-codes.test.ts`, `tests/unit/inventory.test.ts`,
`tests/integration/inventory*.test.ts`, `e2e/products.spec.ts` (automatic code, save and add
another, variants picked on a stock document).

## 12. Current limitations

No price lists or price history per customer; images are not resized on the server (the browser
shrinks photos before upload); no product bundles / kits.

## 13. Future improvements

Bundles (a lock with its installation kit), price lists, supplier part numbers per product,
label printing in batches.
