# Work evidence

## 1. Module purpose

Make sure a visit shows what was done before it counts as done: photos before and after the work,
a short video, the customer's signature and the customer's confirmation, as each kind of visit
requires, and, where the company wants it, a manager's review of the submitted work. The module
builds on the visit photos, signature and delivery checklist that already existed
(`src/server/services/attachments.ts`, `src/lib/delivery.ts`); it does not replace them.

## 2. How users operate it

**Admin (Settings → Work evidence).** "Add rule" opens a form: visit type (or *Any visit type*),
product category (or *Any category*), the minimum number of before and after photos (0–20), and
check boxes for a video, the customer's signature, the customer's confirmation, a manager's review,
and *Active*. Saving a rule for a visit type and category that already has one replaces it. A rule
is switched off with *Active*; rules are never deleted.

**Technician (visit page).** The *Work evidence* card lists what the visit needs with a tick for
each item already there ("After photos: 1 of 2", "Video of the work", …) and what is still
missing. Photos and videos are added in the *Photos and proofs* card (a *Videos* section appears
for the assigned technician; *Before photos* also accepts the technician's photos when the rule
asks for before photos). In *Visit outcome*, choosing *Done* shows "The customer confirmed the work"
and the customer's name when the rule asks for a confirmation. Saving *Done* while something is
missing is refused and the outcome box lists exactly what is missing.

**Reviewer (Work review page `/evidence`, and the visit page).** Tabs *Waiting*, *Sent back* and
*Approved* list visits by their latest review event. On the visit page the reviewer sees the photos
and video, then presses *Approve* (optional note) or *Send back* (reason required).

**Technician after a send-back.** The visit page shows the reason; after adding what was asked,
*Submit again* opens a dialog (customer confirmation again when the rule asks for it, optional
note) and the work goes back to *Waiting*.

## 3. Available features

- Evidence rules per visit type and product category; the most specific active rule applies:
  visit type + category, then visit type, then category, then the rule for every visit.
- Requirements: minimum before photos, minimum after photos, video, customer signature, customer
  confirmation (with the name of who confirmed), manager review.
- Server-side refusal of *Done* while evidence is missing.
- Video upload (MP4, MOV/QuickTime, WebM), at most 3 per visit, size limit `MAX_VIDEO_MB`
  (default 50 MB), played in the page and streamed with HTTP range requests.
- Review workflow: submitted → approved, or → sent back (reason) → submitted again → … with every
  step kept as an event, audited and notified.
- Review queue with three tabs.
- A visit reviewed under a rule that is later switched off keeps its status and history on screen.

## 4. Roles and permissions

| Action | Who | Check |
|---|---|---|
| See / change evidence rules | Admin (`settings.manage`); reviewers can read them | `listEvidenceRules`, `saveEvidenceRule` |
| Add photos / videos to a visit | Assigned technician (`visits.report`) or whoever manages the booking; before photos by technicians only when the rule asks for them | `attachmentRights` in `attachments.ts` |
| Mark done (evidence enforced) | Technicians; people with `appointments.manage` may record a finished visit afterwards without the block (same rule as the delivery checklist), and the work is still submitted for review | `recordVisitOutcome` → `assertEvidenceAndSubmit(…, enforce)` |
| See a visit's evidence status | Anyone who may see the visit | `evidenceStatus` (visit scope) |
| Approve / send back; review queue | `evidence.review` (Admins by default) | `decideWork`, `reviewQueue` |
| Submit again | The visit's technician (`visits.report`) or `appointments.manage` | `resubmitWork` |

## 5. Business rules

- No rule for a visit → nothing extra is required and no review happens (existing behaviour).
- Evidence is counted from the visit's current (not removed) attachments; the customer's
  confirmation is given with each submission.
- When the rule requires a review, marking the visit done submits the work. Work already approved
  is not submitted again; a second *Done* while already submitted does nothing more.
- Only submitted work can be decided; only sent-back work can be submitted again; approved work is
  final.
- A send-back always has a reason (service check and database check).
- Each visit's review steps are serialised by a row lock on the visit, and each event's time is
  taken after that lock, so the order of events is exact.
- Videos are recognised from their bytes, never from the declared type: `ftyp` box with an MP4
  brand or `qt  ` (QuickTime), or an EBML header whose doctype is `webm`. Matroska, audio-only MP4
  (`M4A `) and anything else are refused.

## 6. Database models and relationships

| Model / table | Notes |
|---|---|
| `EvidenceRule` / `evidence_rules` | `visitType`, `productCategory` ('' = any; unique pair), `minBeforePhotos`, `minAfterPhotos`, `requireVideo`, `requireSignature`, `requireCustomerConfirmation`, `requireReview`, `isActive`, `updatedById`. CHECK on the allowed values and 0–20 counts. |
| `WorkReview` / `work_reviews` | `appointmentId` → `appointments`, `event` (`SUBMITTED`, `APPROVED`, `REJECTED`), `note`, `customerConfirmed`, `customerName`, `actorId` → `users`, `createdAt`. **Append-only** (trigger); a `REJECTED` row needs a non-blank note (CHECK). |
| `Attachment` / `attachments` | New kind `VIDEO`. The content-type CHECK now also allows `video/mp4`, `video/quicktime`, `video/webm`; a new CHECK keeps videos and the `VIDEO` kind together. Existing rows satisfy both checks unchanged. |

Migrations: `20261105130000_attachment_video` (enum value only) and `20261105130100_work_evidence`;
both state their rollback at the top.

## 7. API routes

| Route | Method | Purpose |
|---|---|---|
| `/api/evidence/rules` | GET, PUT | List rules; create or replace the rule for a visit type and category |
| `/api/evidence/queue?status=SUBMITTED\|REJECTED\|APPROVED` | GET | Visits whose latest event has that status |
| `/api/appointments/[id]/evidence` | GET | Requirement, what the visit has, what is missing, status, history, what the reader may do |
| `/api/appointments/[id]/evidence/decision` | POST | `{ decision: APPROVED \| REJECTED, note }` |
| `/api/appointments/[id]/evidence/resubmit` | POST | `{ customerConfirmed, customerName, note }` |
| `/api/appointments/[id]/attachments?kind=VIDEO` | POST | Raw video bytes |
| `/api/attachments/[id]` | GET | The file; videos answer `Range` requests (206 / 416) |
| `/api/appointments/[id]/outcome` | POST | Now also accepts `customerConfirmed`, `customerName` |

## 8. Services and important logic

- `src/lib/evidence.ts` (shared with the browser): `ruleFor`, `evidenceMissing`, the zod schemas,
  `EvidenceStatusDTO`.
- `src/server/services/evidence.ts`: rules, `requirementFor`, `assertEvidenceAndSubmit` (called
  inside the visit-outcome transaction), `resubmitWork`, `decideWork`, `evidenceStatus`,
  `reviewQueue` (one SQL statement: the latest event per visit, filtered by status).
- `src/server/storage.ts`: `detectVideoType`, `MAX_VIDEO_BYTES`, `parseRange`,
  `streamStoredFile` (videos are streamed, not read into memory).
- UI: `src/components/evidence/evidence-card.tsx`, the video slot in
  `src/components/appointments/delivery-card.tsx`, the confirmation fields in
  `outcome-panel.tsx`, `src/components/settings/evidence-rules.tsx`, `src/app/(app)/evidence/page.tsx`.

## 9. Validation rules

- Rule form: counts are whole numbers 0–20; unknown visit types / categories refused.
- Decision: `APPROVED` or `REJECTED`; a rejection needs a reason (max 1,000 characters).
- Resubmission: optional customer name (120) and note (1,000).
- Video: real type from the bytes; at most `MAX_VIDEO_MB`; at most 3 per visit. The browser checks
  the size first for a quick message; the server checks everything again.

## 10. Error handling

- Missing evidence: HTTP 422 with `fieldErrors.outcome` listing one missing item per line, in the
  reader's language (Arabic unless English was chosen).
- Wrong state (deciding work that is not submitted, resubmitting work that is not sent back or is
  approved): 422 with a form-level message.
- No right: 403; a visit the reader may not see: 404 (ids reveal nothing).
- Video too large / wrong type / limit reached: 422 with the reason; an unsatisfiable range: 416.

## 11. Tests

- `tests/integration/evidence.test.ts` (15 tests): rules (rights, upsert, audit, validation, most
  specific rule), completion refused with the exact missing list, submission with confirmation,
  managers not blocked but still submitted, no rule = unchanged, review only when required,
  reviewer rights, rejection reason, resubmission, approval, history order, rule switched off
  later, append-only trigger and reason CHECK, video detection, video upload rules and limit, the
  database checks, range parsing.
- `tests/unit/evidence.test.ts`: `ruleFor`, `evidenceMissing`, schemas.
- `tests/integration/erp-api.test.ts`: the routes through the real handlers (401/403/404/422,
  206/416 range responses, Arabic error text).
- `tests/integration/attachments.test.ts`: existing photo tests still pass (the technician's rights
  now include `VIDEO`).
- `e2e/evidence.spec.ts` (Playwright, production build): rule set in Settings, *Done* refused, photo
  and video added, done with confirmation, video served in ranges and refused to anonymous users,
  sent back with a reason, resubmitted, approved, queue tabs.

## 12. Current limitations

- Videos are stored as uploaded (no server-side compression or thumbnail); the browser shows the
  first frame.
- Reviewers are Admins by default (`evidence.review` is not granted to other roles); notifications
  of new submissions go to Admins.
- No separate "completion notes" field: the visit report already required for *Done* serves that
  purpose; reviewers' notes are kept on the review events.
- The rule applies at the moment *Done* is saved; changing a rule later does not re-check visits
  that were already completed.

## 13. Future improvements

- Video transcoding and thumbnails in a background job; upload progress for large files.
- Granting `evidence.review` to a head-of-installations role.
- Per-rule checklists of required photo angles (door front, inside, wiring…).
- Rejection reasons as a pick list for reporting.
