# Data entry

## 1. Module purpose

Make everyday entry fast and hard to get wrong: fewer keystrokes, searchable pickers instead of long
lists, sensible defaults, no lost work, and the same validation messages in the browser as on the
server. This is a set of shared building blocks used by the forms, not a separate page.

## 2. How users operate it

- **Searchable pickers**: type part of a name, code or phone (Arabic letter forms, diacritics and
  case do not matter; words can be in any order); arrow keys and Enter choose; *None* clears where
  allowed. Used for categories, brands, products on stock documents and sales, customers on sales,
  employees on violations, existing products to attach as variants.
- **Defaults from the chosen record**: choosing a product on a sale fills its selling price;
  choosing a visit on a stock issue links its customer; a manual penalty rule fills the penalty and
  amount; empty variant prices take the product's.
- **Remembered choices**: the last unit, category and brand on the product form and the last
  warehouse on a sale are offered again next time (in this browser).
- **Save and add another** (products): saves, then opens a fresh form keeping category, brand, unit and
  serial mode.
- **Copy** (products): a new form pre-filled from an existing product (without its codes).
- **Drafts**: an unsaved new product or sale is kept in the browser while typing; coming back offers
  *Restore* or *Discard*.
- **Codes generated for you**: SKU, variant codes, internal barcodes, document and invoice numbers.
- **Bulk entry**: several variants at once; Excel import for the catalogue and opening stock.
- **Validation as you type**: the same zod schema runs in the browser and on the server; errors show
  under each field in the user's language.

## 3. Available features

`Combobox` (static or server search, keyboard, ARIA combobox / listbox), `foldText` / `filterOptions`
(Arabic-aware matching), `useDraft`, `rememberChoice` / `recallChoice`, `DraftBanner`,
`PasswordInput`, shared `Field` (label, hint, error, required marker), `useAction` (busy state, toast,
field errors, page refresh), idempotent create requests (`requestId`) so a double click never creates
two records.

## 4. Roles and permissions

No permissions of its own: each form's actions are checked by its module. Drafts and remembered
choices are stored in the user's own browser only.

## 5. Business rules

- A draft or a remembered choice never bypasses validation: everything is checked again on save.
- Drafts are cleared after a successful save; storage that is blocked or full is ignored (the form
  still works).
- A remembered choice that no longer exists (e.g. an inactive category) is simply not used.

## 6. Database models and relationships

None (browser `localStorage` only). Idempotency keys (`clientRequestId`) are stored on stock
documents and sales invoices.

## 7. API routes

Server searches used by pickers: `/api/products?q=`, `/api/customers/lookup`, `/api/suppliers/options`,
`/api/inventory/availability`.

## 8. Services and important logic

`src/components/ui/combobox.tsx`, `src/lib/text.ts`, `src/lib/use-draft.ts`,
`src/components/ui/draft-banner.tsx`, `src/components/ui/field.tsx`,
`src/components/ui/password-input.tsx`, `src/components/erp/use-action.ts`; used in
`product-form.tsx`, `variants-panel.tsx`, `document-form.tsx`, `sale-form.tsx`, `penalty-tools.tsx`.

## 9. Validation rules

Shared schemas in `src/lib/validation.ts`, `inventory.ts`, `sales.ts`, `evidence.ts`, `penalties.ts`;
messages are translation keys rendered in the reader's language.

## 10. Error handling

Server field errors are shown under the matching field; form-level errors in a message box; network
failures in a toast without losing what was typed.

## 11. Tests

`tests/unit/forms.test.ts` (Arabic-aware matching), `e2e/products.spec.ts` (automatic code and *save
and add another*), `e2e/arabic.spec.ts` (switching language keeps what is typed), `e2e/sales.spec.ts`,
`e2e/penalties.spec.ts` (searchable employee picker; rule fills the penalty), `e2e/login.spec.ts`.

## 12. Current limitations

Drafts exist for new products and new sales only; stock documents and bookings do not keep drafts
yet (bookings keep their form across language switches). Remembered choices are per browser, not per
account.

## 13. Future improvements

Drafts for stock documents; barcode scanning into pickers on phones; per-account preferences stored
on the server.
