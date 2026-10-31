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
| A: Delivery proof | Photos, signature, payment and deposit proofs, delivery checklist, serial-required setting | `claude/aura-delivery-proof` | In progress |
| B: After-sales | Complaints, ratings, quality grade, satisfaction and quality lists, maintenance reminders | — | Not started |
| C: Field tracking | GPS check-ins, live board, attendance, points, late alerts, automatic repeat-visit fee | — | Not started |
| D: Expenses and car | Transport expenses, Driver role, car route, car check-ins | — | Not started |
| E: Booking helpers | Slot holds, quotation parsing, specialty suggestion, booking rules, site readiness | — | Not started |

## Check results by phase

Results are added here as each phase finishes.
