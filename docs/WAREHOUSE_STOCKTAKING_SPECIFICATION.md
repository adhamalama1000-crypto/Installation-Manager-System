# Warehouse items and stocktaking: specification

What the warehouse item controls and the stocktaking system do, the rules they enforce, and where
each rule lives in the code. Phase 2 of the operational upgrade; it builds on the existing
catalogue, ledger and stocktake engine (`docs/INVENTORY.md`, `docs/modules/STOCKTAKES.md`) and
changes none of their history.

## 1. Item management

| Capability | Where | Permission |
|---|---|---|
| Create and edit items: Arabic and English names, code (automatic or typed), barcode (typed or internal EAN-13), category and subcategory, brand, model, description, unit, purchase and selling price, minimum stock, warranty, serial mode, variants, images | *Products* (existing) | `products.manage` |
| **Technical specifications** (new): up to 30 name / Arabic name / value pairs per item (for example *Voltage = 220 V*). A controlled list, not free database columns | Product form → *Technical specifications*; shown on the product page | `products.manage` |
| **Lock / unlock** (new) | Product page → *Lock* / *Unlock* | `products.lock` / `products.unlock` |
| **Archive / bring back** (new) | Product page → *Archive* / *Bring back*; list filter *Archived* | `products.archive` |
| Deactivate / reactivate (existing) | Product form → *Active* | `products.manage` |

### Lock, inactive and archived are different

| | Information can change | Used in new stock documents and sales | In lists and pickers | Needs zero stock |
|---|---|---|---|---|
| **Locked** | No: names, codes, category, unit, prices, specifications, images and variants are frozen until unlocked | Yes: stock still moves | Yes | No |
| **Inactive** | Yes | No | Yes (filter *Inactive*) | Yes |
| **Archived** | No (read-only until brought back) | No | Hidden (filter *Archived*) | Yes |

- A product with variants is locked, unlocked, archived and brought back **together with its
  variants**; a variant is handled through its product.
- A locked item must be unlocked before it is archived. An item brought back from the archive stays
  inactive until someone reactivates it.
- None of these deletes anything: posted documents, the ledger, stocktakes, sales and reports keep
  showing the item.
- Each change records who, when and the optional reason (`products.lockedAt/By/lockReason`,
  `archivedAt/By`, and an audit entry `PRODUCT_LOCKED`, `PRODUCT_UNLOCKED`, `PRODUCT_ARCHIVED`,
  `PRODUCT_UNARCHIVED`).

**Enforcement in two layers.**
1. The services refuse with a clear message: product form, variants, images, Excel import
   (`assertEditable` in `services/inventory-catalog.ts`).
2. The database trigger `products_guard` refuses any change to a locked or archived product's
   information, and `product_images_locked_product` refuses new images. No code path can bypass
   this, including future code. The cost and version written by stock postings stay writable, so
   stock still moves.

## 2. Stocktaking

### 2.1 Sessions and schedules

- A **stocktake** (session) counts one warehouse: the whole warehouse, or chosen categories
  (subcategories included) and products. Types: **Daily, Monthly, Annual, Custom**.
- **Ad-hoc**: *Stocktakes → Start stocktake* starts one now (existing), optionally with a name and
  scope through the API.
- **Planned**: a **schedule** (*Stocktakes → Stocktake schedules*, permission `stocktakes.schedule`)
  has:
  - name (Arabic and English) and warehouse
  - type
  - repetition (**once, daily, weekly, monthly, yearly**, every N), first day and optional last day
  - start time and time allowed
  - who counts (assignees; empty means anyone who counts stock in that warehouse)
  - supervisor
  - scope (categories and products)
  - mandatory flag
  - instructions
  - status (**Active, Paused, Ended**)
- A schedule creates one **PLANNED** session per occurrence, 45 days ahead (and always the next
  occurrence of an annual schedule).
- Occurrence rules (`src/lib/stocktake-schedule.ts`, unit tested):
  - a monthly schedule on the 31st falls on the last day of shorter months
  - a yearly schedule on 29 February falls on 28 February in other years
  - nothing occurs before the first day or after the last day
- **No duplicates.** A session is unique per (schedule, occurrence day) (database unique key).
  Planning runs inside a lock on the schedule and inserts with `ON CONFLICT DO NOTHING`, so
  planning again, or twice at the same time, never duplicates a session. Planning runs when a
  schedule is saved and whenever the stocktake list or dashboard is opened.
- **Editing a schedule** updates its future planned sessions that nobody changed by hand. Sessions
  on days the schedule no longer occurs on are cancelled (with the reason recorded). Postponed
  sessions keep their new time.
- **Pausing** a schedule stops new sessions. **Ending** it cancels its planned sessions. Schedules
  are never deleted (trigger).

### 2.2 Session controls

| Action | Who | Rule |
|---|---|---|
| Change a planned session (date, time, duration, assignees, supervisor, instructions) | `stocktakes.schedule` | Only while PLANNED. |
| **Postpone** (move it later) | `stocktakes.schedule` | Needs a reason. The original planned start is kept (`postponedFrom`, `postponeReason`). |
| **Cancel** a planned session | `stocktakes.schedule` or `inventory.approve` | A **mandatory** session is cancelled only with a reason. |
| **Start** | `inventory.count`, and an assignee when the session has assignees (planners and approvers always) | The snapshot is taken now and the warehouse is frozen (existing behaviour). One open stocktake per warehouse. Starting late is recorded. |
| Count, add a found product, add photos, submit | Same as *Start* | Only while counting. |
| **Approve** / **reject** / **send back for recount** | `inventory.approve`, with separation of duties and supervisor rules (2.4) | Only while submitted. |
| Cancel an open stocktake | `inventory.approve`; counters while counting | Existing behaviour. |

**Overdue** means a planned session not started by its planned start, or an open session not
finished by its planned end. It is shown in the list (filter *Overdue*), on the session and on the
dashboard.

### 2.3 Counting

For each line the session shows:
- the **system quantity** (and the serial numbers) taken at the start
- the **counted quantity** (by serial for serial-tracked items)
- the **difference**, labelled **Missing** (less found) or **Excess** (more found)
- the **damaged** quantity (part of what was counted; never more than the count)
- the explanation (required for a difference before submitting)
- who counted it and when

Supporting **photos** (images only, up to 40 per stocktake, shrunk in the browser) can be added
while the stocktake is open. They are marked as removed, never deleted.

Example: system 100, counted 95. The line shows difference −5 (Missing 5). The balance stays 100
until the count is **approved**; then the adjustment document posts −5 and the balance becomes 95.

### 2.4 Protection rules

| Rule | How it is enforced |
|---|---|
| Entering a count never changes a balance | Counts are written to `stocktake_lines` only. The balance changes only when the approval posts an **ADJUSTMENT** document through the posting engine, in the same transaction, so it appears in the ledger with the stocktake's number. |
| Original counts and every recount are kept | `stocktake_counts`: one row per entry (round, quantity, serials, damaged, reason, who, when). Append-only (trigger). Shown as the line's *History*. |
| Recount and review | An approver can **send back for recount**: back to counting in a new round. The lines with a difference are flagged (all lines when none differs), and submission is refused until each flagged line is counted again. The snapshot never changes. |
| **Separation of duties** | Setting *Stocktakes are approved by someone who did not count them* (on by default, *Settings*). The person who submitted, or counted any line in any round, cannot approve, reject or send back; the page says why. |
| Supervisor approval | A session with a supervisor is decided only by that supervisor or a stocktake planner (both still need `inventory.approve`). |
| Finalized sessions cannot be silently edited | The trigger refuses any change to an approved, rejected or cancelled stocktake, and counts change only while counting (existing triggers, kept). Corrections after approval go through a new adjustment, or the reversal of the posted adjustment (*cancel posted document*, `inventory.approve`), both audited. |
| Transaction-safe posting | Approval locks the stocktake and the warehouse, checks that the system quantities still equal the snapshot (the warehouse was frozen), and posts all or nothing (existing). |
| Damaged stock | Recorded per line and in the totals. It does **not** by itself move stock: damaged items are still physically present. Moving them out (for example a transfer to a damaged-goods bin, or an adjustment) is a separate, approved stock document. See *Decisions* below. |

### 2.5 Dashboard and reports

*Stocktakes → Stocktake dashboard* shows, for the warehouses the reader may see:
- today's sessions, the next 14 days, active, recently approved, overdue, and waiting for approval
- the month calendar (sessions per day, previous and next month) and the year calendar (per
  month: total, approved, planned, overdue)
- discrepancies of approved sessions (system, counted, difference, damaged)
- products with repeated discrepancies (in two or more sessions, with the net difference)
- each warehouse's record: approved, on time, late, overdue, and the share of exact lines

Filters: warehouse, employee (assignee, supervisor, counter or creator), category, status, and
the period.

## 3. Database changes (additive)

- `20261117100000_stocktake_planned_status`: enum value `PLANNED`.
- `20261117100100_stocktake_schedules_item_lock`:
  - products: `specifications`, `lockedAt/ById`, `lockReason`, `archivedAt/ById` (nullable), and a
    check that an archived item is inactive
  - stocktakes: planning columns (nullable or constant defaults); `snapshotAt` nullable only for
    sessions that never started (check)
  - stocktake_lines: `damagedQuantity` (check ≤ counted) and `recountRequested`
  - new tables `stocktake_schedules`, `stocktake_counts` (append-only) and `stocktake_photos`
    (removal only)
  - guard functions replaced with `CREATE OR REPLACE`, never dropped: `stocktakes_guard` allows
    the snapshot to be set once when a planned session starts; `products_guard` adds the lock and
    archive rule
- Existing rows are unchanged. Rollback notes are at the top of each file.

## 4. Permissions

| Permission | Default roles |
|---|---|
| `products.lock`, `products.unlock`, `products.archive` | Admin, Warehouse manager |
| `stocktakes.schedule` | Admin, Warehouse manager |
| `inventory.count` (start, count, submit) | Admin, Warehouse manager, Store keeper |
| `inventory.approve` (approve, reject, recount, cancel open) | Admin, Warehouse manager |

All are configurable per person or custom role (see `ROLE_PERMISSION_MATRIX.md`).

## 5. Tests

- **`tests/unit/stocktake-schedule.test.ts`:** occurrence rules (once, daily, every N days,
  weekly, monthly with month ends, yearly with 29 February, end date) and schedule validation.
- **`tests/integration/stocktake-planning.test.ts`** (13 tests):
  - lock: service and database refusal; stock still moves; only `products.unlock` unlocks
  - archive: only without stock, not while locked; hidden, read-only, brought back
  - specifications
  - schedules: daily planning with no duplicates under concurrency; monthly and annual dates;
    editing that keeps postponed sessions; ending
  - planner-only changes; postpone reason; mandatory cancellation
  - 100 to 95 with damaged: no balance change until approval, then −5 in the ledger; finalized
    sessions locked
  - separation of duties, and the setting
  - supervisor-only approval
  - recount with an append-only history
  - unauthorized people refused; photos must be images
  - scoped ad-hoc stocktake; dashboard (pending, overdue, discrepancies, warehouse record)
- **`e2e/stocktake-planning.spec.ts`:**
  - lock and unlock through the UI, with API refusals
  - a schedule created in the UI → the store keeper starts, counts 95 of 100 with 2 damaged and
    submits → the manager approves and the adjustment is posted
  - Arabic, phone width
- **`e2e/inventory.spec.ts`** updated: the manager who counted sees why they cannot approve, and
  the Admin approves.

## 6. Decisions for the owner

1. **Separation of duties is on by default.** A one-person warehouse needs an Admin to approve, or
   the setting turned off.
2. **Damaged quantities are recorded, not posted.** Should approval also move damaged stock to a
   damaged-goods location automatically?
3. **Store keepers** count but do not lock items or plan stocktakes by default (configurable).
4. A partial stocktake (by category or product) still **freezes the whole warehouse** while open, as
   the existing engine does, to keep the snapshot exact.
