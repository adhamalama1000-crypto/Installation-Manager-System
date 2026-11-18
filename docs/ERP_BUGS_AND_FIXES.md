# ERP bugs and fixes

Bugs confirmed during the full-system audit (17 November 2026), what was done about each, and the
regression test that keeps it fixed. Only reproduced problems are listed. Ideas and preferences
are in `ERP_FINAL_QA_REPORT.md` under decisions.

Severity: **High** (wrong access or data), **Medium** (a feature unusable for some users or
screens), **Low** (minor or theoretical).

## Fixed

| ID | Severity | Area | Problem (as reproduced) | Fix | Regression test | PR |
|---|---|---|---|---|---|---|
| B1 | High | Booking, permissions | Booking on behalf of a Sales employee, and editing other people's bookings when *Sales can edit each other's bookings* is off, were hard-coded to the Admin role. Nobody else could be given the right; an Installation manager could not do their job. | New permission `appointments.manageAll` (Admin and Installation manager by default, grantable). Every check uses it. | `i:scheduling.test.ts` (on-behalf refused with `ForbiddenError`, allowed for the Installation manager and for a granted Sales user), `i:access-roles.test.ts` | #19 |
| B2 | Medium | Booking | Booking a past date, a closed day or over someone else's hold was hard-coded to the Admin role, could not be granted, and no reason was recorded. | New permission `appointments.override`. A closed day, a technician's day off or hours, and holds need a written reason, stored in the audit entry. Past dates need the permission only. | `i:booking-details.test.ts`, `i:booking-helpers.test.ts`, `i:installation-scheduling.test.ts` | #21 |
| B3 | Medium | Layout | `/products` filter row overflowed the screen at 1024 px (tablet landscape) in English and Arabic: fixed-width grid columns. | Filter grids collapse to three columns at `lg` and use flexible columns from `xl`. | `e:responsive.spec.ts` "tablet landscape" | #20 |
| B4 | Medium | Layout | `/stock`, `/stock/movements`, `/stock/documents` filter rows overflowed by up to 277 px at 1024 px. | Same grid fix. | same test | #20 |
| B5 | Medium | Layout | The *New document* menu opened partly off-screen on phones (320–390 px); the first characters were cut. | On phones the list opens in the page flow; from `sm` it is a positioned menu. | `e:responsive.spec.ts` "phone menus" | #20 |

Each fix was verified by running its regression test before and after. B3–B5 were found by the
overflow sweep (every page at 1024, 768 and 390 px). B1 and B2 were found by reading the booking
service while testing the Installation manager role.

## Open (need a decision or are outside this change)

| ID | Severity | Area | Finding | Why not fixed here | Recommendation |
|---|---|---|---|---|---|
| S1 | Low | Dependencies | Next.js 16.4.3 is affected by advisory GHSA-mfr8-8qww-v76h (`'use cache'` / `unstable_cache`). The app uses neither, so it is not exploitable today. | Upgrading the framework is the owner's call. | Run the Next.js security upgrade (`next upgrade`), then the full test suite. |
| S2 | Medium | Security | The per-IP login rate limit trusts the first `X-Forwarded-For` value. A client that reaches the app directly can change it to avoid the per-IP limit (the per-account limit still applies). | The right fix depends on the hosting setup (which proxy sets the header, and how many hops). | Trust the header only from the known proxy, or use the proxy's real-IP header. Needs the hosting details. |
| S3 | Low | Security | No Content-Security-Policy header. | A strict policy has to be tuned to the map links, inline styles and uploads. Adding one blindly could break pages. | Add a CSP in report-only mode first, then enforce it. |
| S4 | Low | Dependencies | `exceljs` pulls `uuid` < 11.1.1 (advisory about the `buf` argument). The app never calls `uuid` with `buf`. | Not exploitable through the app; waits for an `exceljs` release. | Re-check when `exceljs` updates. |

## Found and fixed during development of the new features (not in released code)

These were caught by the new tests before any release and are listed for completeness.
- A cancelled planned stocktake broke the snapshot check constraint. The unreleased migration was
  corrected before release.
- Existing tests in which the same person counted and approved a stocktake broke under the new
  separation of duties. The tests now use an independent approver; the rule is intended.
- On the company schedule, a company closed day showed as "no set hours" for a technician saved as
  "working, no set hours". A closed day now wins unless that day has set hours.
  `i:installation-scheduling.test.ts` covers it.

## Not bugs (checked)

- `/api/cron/late-check` answers 503 without `CRON_SECRET`. This is by design: it is disabled until
  configured.
- Technicians can read the product catalogue (without costs) and their own van's stock and
  ledger. This is by design (`inventory.view`), and the API sweep confirmed they see only their van.
- A visit outside a reader's scope returns 404, not 403, so its existence is not revealed.
