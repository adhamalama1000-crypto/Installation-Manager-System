# Implementation status

This page is updated after each completed phase. The feature-by-feature comparison with Aura is in [FEATURE_MIGRATION_MATRIX.md](FEATURE_MIGRATION_MATRIX.md).

A phase is marked **done** only when its code is committed, and lint, typecheck, unit and integration tests, the production build and the browser tests all passed on that commit. A phase is **merged** only after the owner approves and merges its pull request.

## Delivered

| Work | Pull request | State |
|---|---|---|
| Performance fixes, Aura phases 1–6 (booking details, visit outcome, leave, payments, inventory, day plan) | #1 | Merged |
| Dashboard counters in one statement, auto-refresh paused while typing | #2 | Merged |
| Arabic-first interface (RTL) with an Arabic/English switch | #3 | Open, awaiting review |

## Remaining Aura features

| Phase | Scope | Branch | State |
|---|---|---|---|
| A: Delivery proof | Photos, signature, payment and deposit proofs, delivery checklist, serial-required setting | `claude/aura-delivery-proof` | Done, pull request open (stacked on #3) |
| B: After-sales | Complaints, ratings, quality grade, satisfaction and quality lists, maintenance reminders | — | Not started |
| C: Field tracking | GPS check-ins, live board, attendance, points, late alerts, automatic repeat-visit fee | — | Not started |
| D: Expenses and car | Transport expenses, Driver role, car route, car check-ins | — | Not started |
| E: Booking helpers | Slot holds, quotation parsing, specialty suggestion, booking rules, site readiness | — | Not started |

## Check results by phase

### Phase A: delivery proof (2026-10-31)

| Check | Result |
|---|---|
| `npm run lint` | No errors |
| `npm run typecheck` | No errors |
| `npm test` (unit and integration) | 17 files, **140 / 140 passed** (11 new: 10 service tests, 1 API test) |
| `npm run build` | Succeeded |
| `npm run test:e2e` | **20 / 20 passed** on a freshly migrated and seeded database; the new delivery test also passed three repeated runs |
| Overflow sweep | **0 problems**: 17 admin pages and 6 technician pages, including a visit with photos, at 320–1024 px in Arabic and English |
| Migration on the development database | `20261028090000_attachments` applied with `migrate deploy`; appointment, customer, user and audit row counts unchanged |

Found and fixed while testing:
- Quick taps on the checklist could lose a tick, because a page refresh started before a save could arrive after it. Saves now run one at a time, and the checklist keeps the ticks of the page.
- Dialogs had no accessible name. All dialogs are now named by their title.
