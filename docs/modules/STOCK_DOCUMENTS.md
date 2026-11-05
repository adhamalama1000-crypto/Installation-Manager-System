# Stock documents

## 1. Module purpose

Every stock movement is a numbered document: goods receipts, issues (to a site, a visit or a
person), transfers between warehouses and bins, customer and supplier returns, adjustments and
opening balances. Documents are prepared as drafts, posted through the posting engine, and
corrected only by reversal.

## 2. How users operate it

*Stock documents* (`/stock/documents`) → *New* and the type. Choose warehouses (and bins), the date,
the counterparty: a **supplier** from the supplier list for receipts and supplier returns, the
**visit code** for issues and customer returns tied to a booked visit (the visit's customer is then
linked to the document; the API also accepts a `customerId` directly), a reference and a note. Add lines with
the product search (availability in the chosen warehouse is shown), quantity, unit cost (receipts),
bins and serial numbers. *Save draft* or *Save and post*. A posted document can be *Cancelled by
reversal* with a reason by an approver. The visit page lists the documents linked to it.

## 3. Available features

Types and prefixes: `OB` opening balance, `GRN` receipt, `ISS` issue, `TRF` transfer, `RTN` return,
`ADJ` adjustment, `STK` stocktake; numbers `PREFIX-YEAR-000001`. Supplier master (`/suppliers`) and
links to customers and visits (since the upgrade); idempotent create, post and cancel; availability
while typing; serial entry with the van's serials as quick picks; costs only for people allowed to
see them.

## 4. Roles and permissions

Receipts and customer returns: `inventory.receive`; issues and supplier returns: `inventory.issue`;
transfers: `inventory.transfer`; adjustment drafts: `inventory.count`; posting adjustments and opening
balances, cancelling posted documents: `inventory.approve`. Suppliers: `suppliers.view` (Admin,
Accountant, Store keeper, Warehouse manager; grantable to Viewers) and `suppliers.manage` (Admin,
Warehouse manager).

## 5. Business rules

- A draft can be edited; a posted document changes only *posted → cancelled*; nothing is deleted
  (triggers on documents and lines).
- The links of a posted document (supplier, customer, visit) cannot change.
- A visit can be linked only if the person may see it; an issue for a visit takes the visit's
  customer.
- Cancellation writes one reversal movement per original movement and is refused when the stock has
  moved on (e.g. a receipt already issued).
- A sale's issue is posted by the sale and cancelled only by cancelling the sale.

## 6. Database models and relationships

`stock_documents` (type, status, number, warehouses, date, reference, counterparty text,
`supplierId` → suppliers, `customerId` → customers, `appointmentId` → appointments, note, created /
posted / cancelled by and when, cancel reason, `clientRequestId`), `stock_document_lines`,
`inventory_movements`, `suppliers` (code, names, contact, phone, email, tax number, address, note,
active; never deleted). Migration `20261105100000_suppliers_document_links` added the supplier
table and the three link columns (nullable).

## 7. API routes

`GET/POST /api/stock-documents`, `GET/PATCH /api/stock-documents/[id]`,
`POST /api/stock-documents/[id]/post`, `POST /api/stock-documents/[id]/cancel`,
`GET/POST /api/suppliers`, `GET/PATCH /api/suppliers/[id]`, `GET /api/suppliers/options`.

## 8. Services and important logic

`inventory-documents.ts` (`createDocument`, `updateDraft`, `resolveLinks`, `documentsForAppointment`),
`inventory-posting.ts` (`postInTx`, `cancelInTx`), `suppliers.ts`; UI
`src/components/erp/document-form.tsx`, `document-actions.tsx`, `supplier-form.tsx`.

## 9. Validation rules

Shared `stockDocSchema`: type-specific warehouses (database CHECK too), at least one line, quantities
and costs as in `INVENTORY.md`, serials per serial mode, reason for adjustments, visit code format,
active supplier.

## 10. Error handling

Posting returns one message per problem line; drafts edited by two people → stale-record message;
unknown supplier / visit → field message; posting into a frozen warehouse names the stocktake.

## 11. Tests

`tests/integration/inventory.test.ts` (every document type, reversals, concurrency, idempotency,
immutability), `tests/integration/product-import.test.ts` (supplier and visit links, links locked
after posting), `tests/integration/inventory-api.test.ts`, `e2e/inventory.spec.ts`,
`e2e/import-suppliers.spec.ts` (supplier picked on a receipt).

## 12. Current limitations

No purchase orders or supplier invoices / payables; returns are not matched to the original receipt
or sale line automatically.

## 13. Future improvements

Purchase orders → receipts; supplier invoices and balances; return against a specific receipt or sale.
