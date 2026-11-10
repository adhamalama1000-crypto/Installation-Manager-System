# Audit log

## 1. Module purpose

Keep a complete, tamper-resistant record of who did what, when, from where and why: sign-ins,
every protected change in every module, permission and role changes, exports of sensitive data,
and administrative corrections. Records are append-only; nobody, the Admin included, can change or
delete them through the application, and the database refuses it as well.

## 2. How users operate it

*Audit log* (`/audit`, Admin only) lists the newest entries first, 50 per page. Filters: free text
(the summary), **module**, **action**, **record id**, **record type**, **who** and **date range**;
*Export CSV* downloads the filtered list (up to 20,000 rows; the export itself is logged).

Each entry shows the record type, the module, the action code, the time (company time zone), the
summary in the reader's language, who did it, the request (`METHOD /path · IP`, with the browser in
the tooltip), the **reason** when one was given, and *Show changes* with the field-level old and new
values. Entries about a booking link to it.

**Corrections.** *Add a correction* on an entry records a **new** entry (`AUDIT_CORRECTION`) for the
same record, with what was wrong and what is right and a required reason; it points to the
corrected entry (`changes.correctsAuditId`). The original entry is never changed; both stay in the
log.

## 3. Available features

What is recorded (each entry with actor, action, module, record type and id, time, old / new values
where something changed, request context and, where applicable, a reason):

| Area | Actions (examples) |
|---|---|
| Sign-in | `LOGIN_SUCCEEDED`, `LOGIN_FAILED` (with the cause), `LOGIN_BLOCKED` (lockout), `LOGOUT` |
| Users and access | `USER_CREATED`, `USER_UPDATED`, `USER_ROLE_CHANGED`, `USER_ACTIVATED`, `USER_DEACTIVATED`, `USER_PERMISSIONS_CHANGED` (Viewer boxes), `USER_ACCESS_CHANGED` (permission matrix, scopes, team, with permissions added / removed), `USER_PASSWORD_SET`, `USER_PASSWORD_CHANGED`, `TEAM_CREATED`, `TEAM_UPDATED` |
| Settings | `SETTINGS_UPDATED`, `STATUS_CREATED`, `STATUS_UPDATED`, evidence rules, work locations |
| Bookings and customers | `APPOINTMENT_CREATED` (with the customer), `APPOINTMENT_UPDATED`, `APPOINTMENT_RESCHEDULED`, `TECHNICIANS_CHANGED`, `STATUS_CHANGED`, `APPOINTMENT_CANCELLED` (with the reason), `CONFIRMATION_CHANGED`, attachments, quotes, checklist |
| Field work and attendance | `CHECK_IN_*` (every check-in at the company, at a visit, on leave, and the car's), `CLOCK_IN`, `CLOCK_OUT`, `ATTENDANCE_ACCEPTED`, `ATTENDANCE_REJECTED`, `VISIT_OUTCOME`, `REVISIT_FEE` |
| Work reports | `WORK_SUBMITTED`, `WORK_RESUBMITTED`, `WORK_APPROVED`, `WORK_REJECTED` |
| Leaves and expenses | `LEAVE_REQUESTED`, `LEAVE_APPROVED`, `LEAVE_REJECTED`, `LEAVE_ADDED`, `LEAVE_CANCELLED`, `EXPENSE_ADDED`, `EXPENSE_CANCELLED`, `EXPENSES_PAID` |
| Complaints and after-sales | `COMPLAINT_OPENED`, `COMPLAINT_RESOLVED` (and the other complaint steps), `CUSTOMER_RATING`, `QUALITY_GRADE`, `MAINTENANCE_CALL` |
| Finance and penalties | `CASH_RECEIVED`, `VIOLATION_PROPOSED`, `VIOLATION_APPROVED`, `VIOLATION_REJECTED`, `VIOLATION_CANCELLED`, `VIOLATIONS_SCANNED` |
| Catalogue, suppliers, inventory | `PRODUCT_CREATED`, `PRODUCT_UPDATED`, variants and images, `PRODUCTS_IMPORTED`, `SUPPLIER_CREATED`, `SUPPLIER_UPDATED`, `WAREHOUSE_CREATED`, `WAREHOUSE_UPDATED`, `STOCK_DOC_CREATED`, `STOCK_DOC_POSTED`, `STOCK_DOC_CANCELLED`, `STOCK_DOC_REVERSED`, stocktakes, serial custody (`STOCK_IN`, `STOCK_MOVED`) |
| Sales | `SALE_CREATED`, `SALE_UPDATED`, `SALE_CONFIRMED`, cancellation with reason |
| Exports | `EXPORTED` for the appointments, reports, finance, inventory, products and audit-log exports (what, filters, row count) |
| Corrections | `AUDIT_CORRECTION` |

The action filter on the page lists every action that occurs in the log.

## 4. Roles and permissions

`audit.view` is an Admin-only permission: it cannot be given to anyone else (it is removed again on
every request even if written into the database), and the service also requires the Admin role. The
page, the export and corrections all check it on the server.

## 5. Business rules

- **Append-only.** A row trigger (`audit_logs_block_modification`, since the first migration)
  refuses every `UPDATE` and `DELETE` on `audit_logs`; a statement trigger (`audit_logs_no_truncate`,
  added in `20261110090000_permissions_teams_audit_context`) refuses `TRUNCATE`, including
  `TRUNCATE … CASCADE` from another table. The application has no route or service that changes or
  removes an entry.
- **Written with the change.** Protected mutations record their entry inside the same database
  transaction as the change, so a change is never saved without its entry and an entry never
  describes a change that was rolled back.
- **Request context.** Every entry written while an API request runs records the IP address (from
  `X-Forwarded-For` / `X-Real-IP`), the browser's user agent (300 characters at most), the method
  and the path (`src/server/request-context.ts`, set up by `apiRoute` and `publicRoute`).
- **No secrets.** Changes are sanitised before they are stored: any key that looks like a password,
  hash, token, secret, cookie, authorization or session is dropped, at any depth. Sign-in entries
  record the email address, never the password; failed sign-ins tell the Admin the cause while the
  person signing in gets one generic message.
- **Corrections are new entries** with a required reason; history is never rewritten.
- Summaries are stored in English and as message keys, so each reader sees them in their language.

The only way to empty the table is for the database owner to opt in inside a transaction
(`SELECT set_config('ims.allow_audit_truncate', 'on', true)`), which the test suite's reset and
`SEED_FORCE=1` seeding (development only, never production) use.

## 6. Database models and relationships

`audit_logs`: `id`, `entityType`, `entityId`, `appointmentId?` (link to the booking), `module?`,
`action`, `summary`, `summaryData?` (message key and values), `changes?` (JSON old / new values),
`reason?`, `context?` (JSON `{ ip, userAgent, method, path }`), `actorId?` → `users`, `createdAt`.
Indexes on `(module, createdAt)`, `(action, createdAt)` and the earlier ones on the record and the
booking. `module`, `reason` and `context` are new, nullable columns: existing entries stay exactly as
they were.

## 7. API routes

| Route | Method | Who | Purpose |
|---|---|---|---|
| `/audit` | page | Admin | The filtered list |
| `/api/audit/export` | GET | Admin | CSV of the filtered list (same query parameters as the page) |
| `/api/audit/[id]/correction` | POST | Admin | `{ reason, note }` → 201; a new correction entry |

## 8. Services and important logic

`src/server/services/audit.ts` (`recordAudit`, `recordExport`, `diffValues`, `sanitizeChanges`,
`MODULE_OF_ENTITY`), `src/server/services/audit-log.ts` (`listAuditLog`, `auditActions`,
`exportAuditCsv`, `recordCorrection`), `src/server/request-context.ts`; interface
`src/app/(app)/audit/page.tsx`, `src/components/audit/correction-button.tsx`.

## 9. Validation rules

Filters are whitelisted (known modules and record types, action codes `A–Z` and `_` only, dates as
`YYYY-MM-DD`, text up to 100 characters with `LIKE` wildcards escaped); a correction needs a note
(up to 2,000 characters) and a reason (up to 1,000).

## 10. Error handling

401 without a session, 403 for anyone but the Admin, 404 for an unknown entry, 422 for a correction
without its note or reason. A database error from the triggers (an attempt to change history) is a
server error and changes nothing.

## 11. Tests

`tests/integration/access-control.test.ts` (append-only: `UPDATE`, `DELETE`, `TRUNCATE` and
`TRUNCATE … CASCADE` refused; corrections; Admin-only listing and filters; the secret sanitiser;
check-in entries), `tests/integration/access-api.test.ts` (sign-in / failure / lockout / sign-out
entries with request context and no password, permission changes with reason and context, exports
logged, export and corrections Admin-only), `tests/integration/users-audit-reports.test.ts`, and the
service tests of each module (each checks its entries); `e2e/access.spec.ts` (filtering by module and
action, the request shown on the entry, a correction through the dialog).

## 12. Current limitations

- The database owner can still opt in to emptying the table (needed for tests and development
  seeding); protecting against the database owner needs database-level roles or off-site log
  shipping.
- Read access to individual records (opening a booking or a customer) is not logged; exports are.
- Entries are kept forever; there is no archive or retention policy yet.

## 13. Future improvements

A restricted database role for the application without `TRUNCATE` rights; shipping entries to
write-once storage; a retention and archive policy; alerts on repeated failed sign-ins.
