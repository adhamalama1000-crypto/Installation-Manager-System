# Sales and sales analytics

## 1. Module purpose

Record what is actually sold (sales invoices) and analyse it: best and least selling products,
products without sales, sales by category and brand, monthly and yearly figures, stock turnover,
slow-moving and low stock, and stock value. Before the upgrade there were no sales records: stock
issues to technicians or sites were the only outflow, and they are **not** sales. Every sales
figure now comes from confirmed sales invoices only.

## 2. How users operate it

**Sales (`/sales`).** The list shows invoices with search, status and date filters and the total
of confirmed sales. *New sale* (`/sales/new`): warehouse, date, customer (searchable among
existing customers, or a walk-in name and phone), optional link to a visit, lines (product search
with availability in the chosen warehouse, quantity, unit price defaulting to the product's
selling price, discount, serial numbers for serial-tracked products), notes. *Save draft* or
*Confirm*. A confirmed sale posts its stock issue at once; if the warehouse does not hold enough,
the confirmation is refused with the line and the quantities. A confirmed sale is corrected by
*Cancel sale* with a reason (people with `sales.void`), which reverses its stock document.

**Analytics (`/analytics`).** Period (default: this year), category, brand, warehouse, product
and "roll variants up into their product" filters. Tiles (revenue, quantity, invoices, average
invoice, cost of goods and gross margin where the reader may see costs, stock value, turnover),
monthly and yearly columns (with a table view), best sellers, lowest sellers, sales by category and
brand, products with no sales in the period, slow-moving stock (no sale for N days while holding
stock), low stock, turnover.

## 3. Available features

- Sales invoices `INV-YYYY-NNNNNN`: draft → confirmed → cancelled (with reason), idempotent create
  (client request id) and confirm.
- Line totals and invoice totals computed exactly (decimal arithmetic, half-up rounding) on the
  server; discounts per line (never more than the line).
- Confirmation posts an `ISSUE` stock document through the existing posting engine: quantities taken
  from the warehouse's locations, serials from where they are, cost recorded per line.
- Cancellation reverses that document (the ledger keeps both).
- Analytics computed in SQL from confirmed invoices; stock figures from balances; costs hidden from
  people who may not see them.

## 4. Roles and permissions

| Permission | Granted to | Allows |
|---|---|---|
| `sales.view` | Admin, Sales, Accountant, Warehouse manager; grantable to Viewers | See sales |
| `sales.manage` | Admin, Sales | Create, edit drafts, confirm |
| `sales.void` | Admin, Accountant | Cancel a confirmed sale (with reason) |
| `analytics.view` | Admin, Accountant, Warehouse manager; Sales when "Sales can view reports" is on; grantable to Viewers | Analytics page |
| Costs and margins | `inventory.reports`, `products.manage`, `inventory.approve` | Cost of goods, margin, stock value |

## 5. Business rules

- **Only confirmed sales invoices are sales.** Transfers, technician and site issues, adjustments,
  returns, drafts and cancelled sales are never counted (tested).
- A confirmed invoice never changes; it is cancelled with a reason. A draft can be edited or
  cancelled.
- Stock leaves only through the posted issue (the ledger), never by editing balances.
- A product that has variants cannot be sold itself: a variant is chosen.
- Variants roll up into their product in analytics when "roll up" is on.

## 6. Database models and relationships

Migration `20261105110000_sales_invoices`. `SalesInvoice` / `sales_invoices` (number, status,
invoiceDate, warehouse, customer or walk-in name and phone, appointment, totals, stockDocumentId →
`stock_documents`, created / confirmed / cancelled by and when, cancelReason, clientRequestId) and
`SalesInvoiceLine` / `sales_invoice_lines` (product, quantity, unitPrice, discount, lineTotal,
unitCost recorded at confirmation, serials). Guard triggers keep confirmed and cancelled invoices
and their lines unchanged.

## 7. API routes

`GET/POST /api/sales`, `GET/PATCH /api/sales/[id]` (drafts), `POST /api/sales/[id]/confirm`,
`POST /api/sales/[id]/cancel`, `GET /api/analytics/sales` (same filters as the page).

## 8. Services and important logic

`src/lib/sales.ts` (schemas, `lineTotal`, `invoiceTotals`), `src/server/services/sales.ts`
(`createSale`, `updateSale`, `confirmSale` → posting engine with `onBehalfOf: "sale"`, `cancelSale`,
`listSales`, `getSale`, `saleWarehouses`), `src/server/services/sales-analytics.ts` (one SQL
statement per block, run in parallel). UI: `src/app/(app)/sales/*`, `src/app/(app)/analytics/page.tsx`,
`src/components/sales/*`. Charts follow the validated palette and have a table view.

## 9. Validation rules

At least one line; quantity > 0 (whole for whole units); price ≥ 0; discount ≥ 0 and not above the
line; serial count equal to the quantity for serial-tracked products; customer or walk-in name;
cancel reason required.

## 10. Error handling

422 with per-line messages (e.g. "Not enough AQ-HUB-M3 in the warehouse: 0 available, 2 needed.");
403 without the right; 404 for invoices the reader may not see; repeated requests return the same
invoice.

## 11. Tests

`tests/integration/sales.test.ts` (7): exact totals and posting from the right bins and serials
with cost; insufficient stock refused with nothing moved; line validation; cancellation rights and
reversal; idempotency and visibility; **only confirmed sales are counted** (transfers, technician
issues, adjustments, drafts and cancelled sales excluded); filters, roll-up and costs hidden from
Sales. `e2e/sales.spec.ts`: a sale confirmed in the UI appears in the analytics.

## 12. Current limitations

No tax (VAT) lines, price lists, quotations-to-invoice flow, customer payments against invoices or
printable invoice layout; visit prices (bookings) remain separate from sales invoices.

## 13. Future improvements

VAT, printable / PDF invoices, payments and balances per invoice, price lists, converting a visit's
quotation into a sale, sales targets per salesperson.
