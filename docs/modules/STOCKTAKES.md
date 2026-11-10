# Stocktakes

## 1. Module purpose

Count a warehouse physically, compare with the system, explain differences, and correct the stock
with one approved adjustment, while the warehouse is frozen so the count stays meaningful.

## 2. How users operate it

*Stocktakes* (`/stocktakes`) → *Start* for a warehouse: a snapshot of the system quantities (and
serials) per product and bin is taken and the warehouse is frozen. On the count sheet each line shows
the system quantity, the counted quantity, the difference and an explanation; serials are ticked or
typed; a product found that was not in the snapshot can be added. *Submit* when done. An approver
*Approves* (one adjustment document `ADJ-…` is posted for all differences and the warehouse is
unfrozen) or *Rejects* (back to counting) or the count is *Cancelled*.

## 3. Available features

Snapshot with serials; partial saving of counts; explanations per line; products found during the
count; approval into one adjustment; rejection and cancellation; idempotent approval; optional
serials counted and adjusted by name (since the upgrade); variants counted like any product.

## 4. Roles and permissions

`inventory.count` (Store keeper, Warehouse manager, Admin): start, count, submit, cancel;
`inventory.approve` (Warehouse manager, Admin): approve or reject.

## 5. Business rules

- One open stocktake per warehouse; postings into it are refused while it is open.
- The snapshot of a line never changes; counts change only while counting; a closed stocktake never
  changes (triggers).
- Approval posts one adjustment through the posting engine; serial differences become serial
  movements (missing ones out, found ones in).
- A product that has variants cannot be a stocktake line (its variants are counted).

## 6. Database models and relationships

`stocktakes` (warehouse, status, number, who started / counted / submitted / decided, adjustment
document), `stocktake_lines` (product, bin, system quantity and serials, counted quantity and serials,
explanation, counted by).

## 7. API routes

`GET/POST /api/stocktakes`, `GET /api/stocktakes/[id]`, `POST /api/stocktakes/[id]/counts`,
`/lines`, `/submit`, `/approve`, `/reject`, `/cancel`.

## 8. Services and important logic

`src/server/services/stocktakes.ts` (exclusive warehouse lock while starting and closing; the
posting engine for the adjustment); UI `src/components/erp/stocktake-forms.tsx`.

## 9. Validation rules

Counted quantities ≥ 0 (whole for whole units); serial counts per serial mode; explanation required
for a difference when submitting.

## 10. Error handling

Starting a second count on a warehouse names the open one; approving twice returns the same result;
counting after submission is refused; a product with variants as a line is refused.

## 11. Tests

`tests/integration/stocktakes.test.ts` (snapshot, freeze, partial counts, explanations, approval into
one adjustment, serial swaps, found products, rejection, cancellation, idempotency, audit),
`tests/integration/product-variants.test.ts` (optional serials, variant parent refused),
`e2e/inventory.spec.ts`.

## 12. Current limitations

Whole-warehouse counts only (no cycle counts of a few bins or products); no blind-count mode.

## 13. Future improvements

Cycle counts by bin or category; blind counts (system quantity hidden); count sheets on phones with
barcode scanning.
