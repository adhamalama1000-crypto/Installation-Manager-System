# SKU and barcode

## 1. Module purpose

Give every product and variant a unique code automatically, safely when several people create
products at the same moment, and issue internal barcodes for products that have none, while still
accepting codes and barcodes typed by hand.

## 2. How users operate it

Leave *SKU* empty on the product form (or in the import file) and the code is generated on save.
Give a category a *code* (Setup → Categories, e.g. `LCK`) to use it as the prefix. Tick *Generate
barcode* (or `generate_barcode = yes` in the import) to receive an internal EAN-13 barcode. A typed
SKU or barcode is kept as typed (checked for uniqueness). The product page shows the barcode as a
printable EAN-13 symbol.

## 3. Available features

- SKU format `PREFIX-00001`: prefix = the category's code, else its parent's code, else `PRD`;
  five digits; per-prefix counter.
- Variant codes `PARENT-NAME` from the variant's English name (capitals and digits, at most 8),
  else `PARENT-V1`, `PARENT-V2`…; always within 64 characters.
- Internal barcodes: `2` + 11-digit counter + EAN-13 check digit (the in-store range, which does not
  clash with manufacturers' GS1 barcodes).
- Bulk reservation for imports (one counter update for a block of codes).

## 4. Roles and permissions

Codes are generated for whoever may create products (`products.manage`); category codes are set in
Setup by the same people.

## 5. Business rules

- Numbers come from `document_sequences` with `INSERT … ON CONFLICT DO UPDATE … RETURNING`; the
  counter row stays locked until the transaction ends, so concurrent creations are served one after
  the other and never receive the same number.
- A number already taken by a hand-typed code is skipped (up to 500 tries).
- Unique indexes on `products.sku` and `products.barcode` are the final guarantee.
- Codes are stored in capitals; changing a product's category later does not change its SKU.

## 6. Database models and relationships

`document_sequences` (key `SKU:<prefix>`, `BARCODE:INTERNAL`), `catalog_categories.code`,
`products.sku`, `products.barcode`.

## 7. API routes

No separate route: `POST /api/products`, the variants routes and `POST /api/products/import`
generate codes.

## 8. Services and important logic

`src/server/services/product-codes.ts` (`skuPrefix`, `nextSku`, `nextVariantCode`,
`nextInternalBarcode`, `reserveSkus`, `reserveBarcodes`), `src/lib/product-codes.ts` (`formatSku`,
`codeFromName`, `variantCodeCandidates`, `ean13CheckDigit`, `isValidEan13`, `internalEan13`),
`src/components/erp/barcode.tsx` (EAN-13 symbol as SVG).

## 9. Validation rules

Typed SKU: letters, digits, `-`, `_`, `.`, at most 64; category code 2–6 characters, capitals and
digits starting with a letter; a 13-digit barcode must have a valid check digit.

## 10. Error handling

Duplicate typed codes: 422 naming the product that has it. If no free number is found within the
try limit: 422 "No free code" (has never happened in tests).

## 11. Tests

`tests/unit/product-codes.test.ts` (format, category codes, variant suffixes, EAN-13 check digits on
known codes, internal range, symbol encoding), `tests/integration/product-variants.test.ts`
(generation, skipping taken numbers, **12 concurrent creations get 12 different SKUs**, internal
barcodes valid and unique, typed barcode kept), `tests/integration/product-import.test.ts`
(bulk generation), `e2e/products.spec.ts`.

## 12. Current limitations

No GS1 company prefix management (only internal barcodes are issued); no reuse of numbers freed by
deactivated products (by design).

## 13. Future improvements

GS1 barcodes when the company obtains a prefix; Code 128 labels for bins and serials.
