# Implementation plan

Ordered plan for the bilingual upgrade and the legacy feature migration. Every step is a separate,
independently testable commit on `claude/vibrant-maxwell-m926bt`; each schema change is an additive
migration. Progress is tracked in `IMPLEMENTATION_STATUS.md`.

## Guiding decisions

| Decision | Reason |
|---|---|
| Keep Next.js + Prisma + PostgreSQL as the only architecture | It already has the stronger guarantees (exclusion constraint, append-only audit, scoped queries); legacy code is a behaviour reference only |
| **Locale by cookie + saved user preference, no URL prefix** | Every route, link, bookmark and test stays valid; an internal app does not need locale URLs for SEO. Order of resolution: user's saved language → `aura_locale` cookie → `Accept-Language` → Arabic |
| **In-repo typed dictionaries instead of a library** | No i18n library is installed; the needs (two languages, plurals, interpolation, server + client) fit in ~200 lines. English is the source of truth; `ar` is typed against it so a missing or extra key fails `npm run typecheck`, and `tests/unit/i18n.test.ts` checks placeholders and plural forms |
| Arabic with **Latin digits** (`ar-EG-u-nu-latn`) | Phone numbers, serials, codes and amounts are typed and read in Latin digits by the team (the legacy app did the same); mixing digit systems in one screen causes errors |
| Server text as **message descriptors** (`key` + params) | Errors, notifications and audit entries are rendered in the reader's language. The English text is still stored for search and for old rows |
| `dir="rtl"` on `<html>` + Tailwind logical utilities (`ms-`, `pe-`, `start-`, `text-start`) | One stylesheet for both directions; Latin values are isolated with `<bdi dir="ltr">` so phones, ids and e-mails never reverse |
| Arabic font: IBM Plex Sans Arabic via `next/font` (self-hosted at build), Poppins kept for Latin | Readable Arabic UI weights; keeps the existing brand typeface |
| Private file storage on disk behind an authorised route, behind a storage interface | Legacy files were public Drive links; the interface allows S3 later |
| New enforcement rules (delivery checklist, signature, photos, serials) are **settings, off by default** | Turning them on silently would change how existing users finish visits; Admins enable them |

## Phases

1. **Audit** – `SYSTEM_AUDIT.md`, `FEATURE_MIGRATION_MATRIX.md` (done first).
2. **Plan** – this document.
3. **Foundation**
   1. `src/i18n/`: dictionaries (`en`, `ar`), `t()` with interpolation and Intl plural rules,
      locale resolution, server helper `getI18n()`, client `I18nProvider` / `useI18n()`,
      locale-aware formatting (dates in the company timezone, numbers, money).
   2. Migration `user_locale` (`users.locale`), `PUT /api/me/locale`, language switch in the
      header, sidebar, login page and profile.
   3. Root layout: `lang`/`dir`, Arabic font, RTL-safe toaster position.
   4. Translatable server errors (`AppError` message descriptors translated in `errorResponse`),
      zod messages as keys, `Field` renders translated messages.
   5. Completeness check (typecheck + unit test) and `react/jsx-no-literals` lint rule for
      components and pages so hard-coded UI text is caught.
4. **Translate the existing product** – every page and component, enum labels (roles, statuses
   kinds, categories, visit types, confirmation, payment methods, stock states, leave types),
   notifications (`notifications.params`), audit actions and summaries (`audit_logs.params`),
   status names (`appointment_statuses.nameAr`), CSV headers and values, WhatsApp texts.
5. **Legacy features**, in this order (each: migration → service with permission checks and audit →
   API → UI in both languages → tests):
   1. Booking rules: no past bookings for non-Admins; slot holds; site readiness; equipment location;
      technician specialty.
   2. Complaints.
   3. File storage + visit evidence (photos, signature, payment/deposit proof), delivery checklist,
      serial-required and delivery-rule settings, customer rating and quality grade.
   4. Check-ins: attendance and visit stages, problem reasons + repeat-visit fee, field board,
      attendance report, late check endpoint.
   5. Expenses with receipts; statement extended with expenses and attendance.
   6. Performance points (configurable weights) and maintenance/satisfaction/quality lists.
   7. Company car: vehicles, DRIVER role, route page, driver stages.
   8. Quotation parsing with host allow-list.
   9. Legacy import tool (`scripts/import-legacy.ts`).
6. **Verification** – lint, typecheck, unit + integration tests on a dedicated database, production
   build, Playwright (English and Arabic, RTL/LTR, mobile/desktop, roles).
7. **Final review** – diff review, `IMPLEMENTATION_STATUS.md`, README update.

## Database changes (all additive)

| Migration | Change |
|---|---|
| `i18n` | `users.locale`, `appointment_statuses.nameAr`, `notifications.params`, `audit_logs.params` |
| `booking_rules` | `slot_holds`; appointment `siteReadiness`, `internetStatus`, `equipmentAt`; user `specialty` |
| `complaints` | `complaints` table + sequence number, priority/status enums |
| `evidence` | `attachments` table; appointment `checklist` (JSON), `customerRating`, `ratingNote`, `qualityGrade`, `maintenanceFollowUps` |
| `checkins` | `checkins` table, stage enum |
| `expenses` | `expenses` table |
| `vehicles` | `vehicles`, appointment `vehicleId` + `routeOrder`, `Role.DRIVER` |
| `quotation` | appointment `quotationUrl`, `quotation` (JSON snapshot) |
| `legacy_ref` | appointment `legacyRef` unique (import idempotency) |

Deletion policy: business rows are never deleted (`ON DELETE RESTRICT`); attachments are
soft-deleted (`deletedAt`) so the audit trail keeps the reference; holds expire and are cleaned up.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Translating ~70 files can silently break existing tests that select by English text | e2e tests run in English (`Accept-Language: en`); new e2e tests cover Arabic |
| RTL breaks absolutely positioned elements (sidebar, calendar now-line, popovers) | Logical properties; screenshot checks in both directions at 390 px and 1280 px |
| Double counting money when expenses enter the statement | Expenses are a separate table and section; statement totals computed in SQL; tests assert totals |
| Holds racing with bookings | Holds take the same per-technician advisory lock as bookings |
| Server fetch for quotations (SSRF) | Host allow-list, https only, 5 s timeout, 2 MB cap, no redirects to other hosts |

## Verification strategy

* Unit: dictionaries (completeness, placeholders, plurals), formatting, quotation parser, route
  ordering, points formula, WhatsApp templates in both languages.
* Integration (PostgreSQL): every new service — permissions per role, validation, audit rows,
  notifications, concurrency (holds vs bookings), money totals, attachment access control.
* E2E (Playwright): language switch persists across navigation/refresh/sign-in; Arabic pages are
  `dir=rtl` with no horizontal overflow at 390 px; complaint lifecycle; attendance; expense;
  existing flows keep passing in English.
