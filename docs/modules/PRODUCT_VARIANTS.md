# Product variants

## 1. Module purpose

Sell and stock the same product in several colours or configurations (a lock in black, silver and
gold; a camera in 2 MP and 4 MP) with one product page, while each variant has its own code,
barcode, prices, minimum stock, images, stock per warehouse and bin, and serial numbers.

## 2. How users operate it

On a product page, *Variants* → *Add variants* lets the user type several variants at once
(English and Arabic names, optional colour, optional code, prices; empty prices take the product's).
Each variant can be edited on its own. An existing standalone product can be attached as a variant
(*Attach existing product*), and a variant can be detached back into a standalone product. On stock
documents, sales and stocktakes, product pickers list the variants (with the product's name and the
variant's name), never the product that has variants.

## 3. Available features

Bulk creation; automatic variant codes (`PARENT-NAME`, else `PARENT-V1`, `PARENT-V2`…); own
barcode (typed or internal EAN-13); own cost, price, minimum stock, colour, images; shared details
(category, brand, unit, model, description, warranty, serial mode) follow the product; list shows
the variants' total stock; search finds a product by a variant's code.

## 4. Roles and permissions

`products.manage` to create, edit, attach and detach; `products.view` to see. Stock actions on
variants use the normal inventory permissions.

## 5. Business rules

- A variant is a product row with `parentId`; it has no variants of its own; a product is never its
  own parent (CHECK constraints).
- A product can receive variants only when it is active, is not a variant, and holds no stock itself.
- Once a product has variants, **no ledger movement can be written for it** (trigger
  `inventory_movements_variant_parent`): its stock lives on the variants.
- Renaming the product or changing a shared detail updates every variant; the unit is locked once
  any variant has moved stock.
- Changes are serialised per product (row lock) and audited.

## 6. Database models and relationships

`products.parentId` → `products.id`, `hasVariants`, `variantNameEn`, `variantNameAr`, `colorHex`;
everything else (balances, movements, serials, images, sales lines) points at the variant's own
product row, so the ledger and posting engine are unchanged. Migration
`20261105090000_product_variants`.

## 7. API routes

`GET/POST /api/products/[id]/variants`, `PATCH /api/products/[id]/variants/[variantId]`,
`POST /api/products/[id]/variants/attach`, `POST /api/products/[id]/detach`.

## 8. Services and important logic

`src/server/services/product-variants.ts` (`addVariants`, `saveVariant`, `attachVariant`,
`detachVariant`), `variantCodeCandidates` in `src/lib/product-codes.ts`, `variantsBulkSchema` and
`variantSchema` in `src/lib/inventory.ts`, `src/components/erp/variants-panel.tsx`.

## 9. Validation rules

Both variant names required and unique within the product (case-insensitive); codes and barcodes
unique across the catalogue; prices ≥ 0; colour `#RRGGBB`; up to 50 variants per request.

## 10. Error handling

422 with per-row messages (duplicate name or code, parent holds stock, parent inactive, product is a
variant); 409 for a stale edit; 403 without `products.manage`.

## 11. Tests

`tests/integration/product-variants.test.ts` (variants with own codes, prices and barcodes; stock
only on variants, enforced by the database; listing and search; shared details follow; optimistic
locking and audit; refusal when the parent holds stock; attach / detach; stocktake refusal of a
product with variants), `tests/unit/product-codes.test.ts` (variant suffixes),
`e2e/products.spec.ts` (list, add several, edit one, pick on a stock document).

## 12. Current limitations

One level of variants (no variant matrices such as colour × size generated automatically); a
product that already holds stock must be emptied (or its stock transferred to a variant through
documents) before it can get variants.

## 13. Future improvements

Attribute matrices (colour × finish) with generated combinations; moving a product's own stock
onto a new variant with one guided transfer.
