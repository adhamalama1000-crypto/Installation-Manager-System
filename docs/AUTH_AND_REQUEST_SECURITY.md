# Sign-in protection and request limits

How the app protects the sign-in from brute force and denial of service, and how it limits request
bodies. Configuration is by environment variables; every one has a safe default, so nothing has to
be set for a single server reached directly.

## 1. Password checks run on worker threads

A bcrypt check (cost 12) takes about 300 ms of CPU. On the main thread it stalls every other
request: before this change, 60 simultaneous failed sign-ins pushed the health check to a 12 s p95.
Passwords are now checked and hashed on a small, fixed pool of worker threads
(`src/server/auth/hash-pool.ts`). The main thread only passes messages.

| Variable | Default | Meaning |
|---|---|---|
| `AUTH_HASH_THREADS` | `min(2, max(1, CPU cores − 1))` | Worker threads (1–16). Each one checks about 3 passwords per second |
| `AUTH_HASH_MAX_QUEUE` | `12 × threads` | Checks allowed to wait for a free worker. Beyond that a sign-in is refused at once |
| `AUTH_HASH_QUEUE_TIMEOUT_MS` | `5000` | Longest wait in the queue before the sign-in is refused |
| `AUTH_HASH_JOB_TIMEOUT_MS` | `10000` | Longest single check; a worker that takes longer is terminated and replaced |
| `AUTH_HASH_PRIORITY_RESERVE` | `max(threads, ⌈(threads + queue) / 3⌉)` | Places kept for **priority** checks (known devices, signed-in users). Ordinary sign-ins may only use the rest |
| `AUTH_HASH_MAX_PER_CLIENT` | `2` | Checks one client may have running or waiting at once (a trusted address, a known device, a signed-in user). `0` = no limit |

The pool has two lanes. **Priority** checks (a sign-in from a known device, see §2, and password
changes by signed-in users) may use every place and always start before waiting ordinary ones.
**Standard** checks (sign-ins from browsers the account does not know) may only fill the pool up to
the reserve. So a flood of sign-ins can never take the places a known device needs, and one client
(one trusted address, one device, one user) can never hold more than `AUTH_HASH_MAX_PER_CLIENT`
places. These limits are per process: the pool and its CPU belong to that process, so nothing has
to be shared between instances.

- When the pool is full, or a check waits too long, the request gets **503** with `Retry-After: 5`
  and the message "Sign-in is busy right now". The answer is the same for every account, and the
  attempt is not counted against the account or the address.
- A worker that crashes or hangs is replaced. If workers keep crashing (more than 3 in a minute) the
  replacement waits 1 s, then longer, up to 30 s, so a broken installation cannot spin the CPU; new
  requests during that wait do not start workers early. A check that only timed out does not count
  as a crash.
- Workers are created once and reused; they do not keep the process alive on shutdown, and closing
  the pool fails waiting checks cleanly.
- Hashes are unchanged: the same bcryptjs library, `$2a$`/`$2b$`/`$2y$` hashes of any cost still
  verify, new hashes use cost 12. No password needs to be reset.
- Unknown emails are checked against a fixed dummy hash, so they cost the same work and time as a
  real account and get the same answer.
- Passwords and hashes are only passed in messages to the workers; nothing logs them, and a worker
  error reports only the error's type.

Sizing: leave at least one core for the main thread. On a 4-core server the default of 2 threads
handles about 6 checks per second while the rest of the app stays responsive.

## 2. Sign-in limits

Counters live in PostgreSQL (table `auth_rate_limits`), so every app instance shares them. Each
request takes its slot with one atomic statement
(`INSERT … ON CONFLICT DO UPDATE SET count = count + 1 RETURNING count`). PostgreSQL serialises the
increments on the row, so with any number of simultaneous requests, on any number of instances,
exactly `limit` of them are let through. There is no read-then-write step.

| Variable | Default | Meaning |
|---|---|---|
| `LOGIN_MAX_FAILURES_PER_ACCOUNT` | `5` | Attempts per account **per client** per window: per (account, trusted address) behind a trusted proxy, per account without one, per known device |
| `LOGIN_MAX_FAILURES_PER_ACCOUNT_TOTAL` | `10` | Attempts per account per window across **all** trusted addresses together (behind a trusted proxy) |
| `LOGIN_MAX_FAILURES_PER_IP` | `30` | Attempts per client address per window, any accounts (only with a trusted proxy, see below) |
| `LOGIN_FAILURE_WINDOW_MINUTES` | `15` | Window length for the limits above |
| `LOGIN_MAX_FAILURES_GLOBAL_PER_MINUTE` | `300` | Attempts per minute across all accounts and addresses, for browsers the account does not know |
| `LOGIN_ATTEMPT_RETENTION_DAYS` | `30` | How long raw sign-in records (`login_attempts`) are kept |

### Known devices

After a successful sign-in the browser gets a random **device token** in an httpOnly cookie
(`ims_device`, sent only to `/api/auth`, 90 days). Only its SHA-256 is stored (table
`login_devices`, at most 10 per user, expired ones deleted hourly), so every instance shares it. A
later sign-in **to the same account** with that cookie is a known-device sign-in:

- it is limited only by its own counter (`LOGIN_MAX_FAILURES_PER_ACCOUNT` per window per device),
  not by the account, address or global limits;
- its password check uses the pool's priority lane.

The token is not a credential: the password is checked every time, and a token for another account,
an unknown token or an expired one is ignored (the sign-in is treated as an unknown device). It only
exists after a correct password, so an attacker cannot create one for someone else's account.

### Order of checks

Unknown device (no valid device cookie for this account):

1. The pool's standard lane must have room and the client must be under its per-client limit,
   otherwise **503** at once (no database work).
2. The **global** counter and, for a trusted address, the **address** counter, in one statement.
   Over either: **429**. A request refused here writes nothing for any account. Once an instance has
   seen the global limit reached, it refuses unknown-device sign-ins **without any database work**
   until that minute ends (it can only refuse a little early, never let more through).
3. The **account** counters, in one statement: behind a trusted proxy the (account, address) pair
   (5) and the account across all addresses (10); without one the account alone (5). Over either:
   **429**, and the global/address slots are given back.

Known device: its own device counter only (5 per window), then the priority lane.

4. The password is checked. Success clears that attempt's account/device counters and gives back
   the address and global slots. Failure keeps the counts. A check that could not run (pool busy,
   worker failure) gives back every slot. A known-device success does **not** clear the account's
   counter, so an attacker's lock on the account stays in place for unknown devices.

So the counters hold failures plus attempts still in progress. A successful sign-in does not use
up anyone's allowance.

- **Unknown emails** are limited exactly like real ones, so the lockout does not reveal which
  emails exist. The counters store a SHA-256 of the email, never the email itself.
- **Fail closed:** if the counters cannot be read or written (database down), sign-in is refused
  with 503. The limits are never skipped.
- **Targeted lockout:** someone who knows an email can still lock that account **for unknown
  devices** (5 failures per window, or 10 from several addresses behind a proxy). They cannot lock
  out the person's known devices, and behind a trusted proxy they cannot lock out other addresses
  either. A first sign-in from a new browser during such an attack waits until the window ends.
- **Floods:** without a trusted proxy every unknown client is "unknown", so a flood from anywhere
  can fill the standard lane and trip the global limit: sign-ins from **new** browsers are then
  refused (503/429) until it stops, while known devices keep signing in. Behind a trusted proxy one
  address cannot do this (2 places in the pool, 30 failures per window); a flood from many addresses
  still can. Put a rate-limiting reverse proxy in front for internet-facing deployments.
- **Windows are fixed** (aligned to the clock). An attacker can use one window's allowance at its
  end and the next at its start: at most 2 × the limit in a short time, then the limit per window.
- **Growth is bounded:** every counter row has an expiry. Each instance deletes expired rows at
  most once a minute, and raw sign-in records older than the retention at most once an hour, in
  batches of 5,000, in the background. The deletes are idempotent, so instances running them at
  the same time is safe.

### Admin lockout

`npm run reset-admin-password` (scripts/admin-password.ts) reads the same counters: it shows
whether `admin@example.com` or any address is locked, and a reset clears the admin's account
counter and its per-address counters. The raw records in `login_attempts` are kept for
investigation. Known devices are not affected.

### Password changes

`POST /api/me/password` (a signed-in user changing their own password) is limited like a sign-in:
`LOGIN_MAX_FAILURES_PER_ACCOUNT` attempts per user per window (counter `pwchange:<user id>`), then
**429** with `Retry-After`. Every wrong current password is audited (`USER_PASSWORD_CHANGE_FAILED`),
the lock once (`USER_PASSWORD_CHANGE_BLOCKED`), never with a password or hash. The checks use the
pool's priority lane with the user as the client (at most 2 at once). The new hash is only written
if the stored one is still the one that was checked, so two simultaneous changes cannot both win
(the other gets **409**). A successful change signs out every other session, as before. If the
counters cannot be reached the change is refused (**503**).

## 3. Client addresses and trusted proxies

Next.js route handlers do not see the TCP peer address, and anyone can send an `X-Forwarded-For`
header. So the app believes that header only as far as you say proxies are trusted:

| Variable | Default | Meaning |
|---|---|---|
| `TRUSTED_PROXY_HOPS` | `0` | Number of reverse proxies in front of the app that append to `X-Forwarded-For` (0–10) |

- `0` (default): forwarding headers are ignored. Every client's address is `unknown`. The
  per-address limit is **off** (one shared "unknown" bucket would let one attacker lock everyone
  out); the per-account and global limits still apply. Audit entries and sessions record `unknown`.
- `1`: one proxy (nginx, Caddy, IIS ARR, a cloud load balancer). The client is the **rightmost**
  entry, the one that proxy appended. Anything the client wrote further left is ignored.
- `2`: two proxies (e.g. a CDN in front of nginx): the second entry from the right, and so on.
- `X-Real-IP` and any other header are never used.
- An entry that is not an IP address, or a header with fewer entries than `TRUSTED_PROXY_HOPS`
  (the request did not come through all the proxies), gives `unknown`. Ports, brackets and
  IPv4-mapped IPv6 (`::ffff:1.2.3.4`) are normalised.

Set it only if **every** request reaches the app through those proxies (block direct access to
the app's port with a firewall). Otherwise a client can reach the app directly and choose its own
address. Examples:

```nginx
# nginx: appends the real peer address; TRUSTED_PROXY_HOPS=1
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
```

For IIS with Application Request Routing, enable "Preserve client IP" (`X-Forwarded-For`) and set
`TRUSTED_PROXY_HOPS=1`.

## 4. Request bodies

JSON bodies (every API route that reads JSON) are limited to 1 MB and are never held in memory
beyond that:

- A `Content-Length` above the limit is refused (**413**) before anything is read.
- `Content-Length` is not trusted: the body is streamed and counted, so a missing or false length,
  or a chunked body, is cut off (**413**) as soon as it passes the limit, and the stream is
  cancelled.
- A malformed, negative or contradictory `Content-Length` is refused with **400**. (Node's HTTP
  parser already refuses most of these before the app; the app checks again.)
- A body cut short by the client gets **400** (`errors.bodyIncomplete`); one that does not finish
  arriving within `JSON_BODY_TIMEOUT_MS` (default `60000`, 1–600 s) gets **408**.
- Unchanged: wrong content type and malformed JSON still answer 422 with the same messages.
  Error bodies keep the usual `{ error: { code, message, fieldErrors: { _form } } }` shape.

### File uploads

File uploads (photos, videos, proofs, receipts, product images, imports) have their own size limits
(`MAX_UPLOAD_MB`, default 8; `MAX_VIDEO_MB`, default 50; imports 10 MB) and are read by
`readLimitedBody` (`src/server/storage.ts`):

- A larger declared `Content-Length` is refused before reading; a malformed or contradictory one
  gets **400**. The bytes are counted as they arrive, so a false or missing length changes nothing.
- **Memory budget per process:** before reading, the body's size (declared, else the limit) is
  reserved from `UPLOAD_MAX_INFLIGHT_MB` (default 256). When uploads in progress use it up, further
  uploads get **503** with `Retry-After` at once instead of piling up in memory.
- A body that stops arriving for `UPLOAD_IDLE_TIMEOUT_MS` (default 30 s) or takes longer than
  `UPLOAD_TOTAL_TIMEOUT_MS` (default 15 min) gets **408**; an upload the client aborts gets **400**
  (not a 500). The stream is cancelled and the reservation released in every case.
- Visit attachments (`POST /api/appointments/[id]/attachments`) check the caller's right to add that
  kind to that visit **before reading a single byte**; a caller who may not upload never makes the
  server receive the file. (The other upload routes still read the body first and check rights
  when saving; their bodies are bounded by the limits above.)

## 5. Audit entries and investigations

The audit log is append-only (database triggers). To keep a flood from filling it:

| Event | Audit entry |
|---|---|
| Successful sign-in | `LOGIN_SUCCEEDED`, every time |
| Wrong password / inactive account (existing account) | `LOGIN_FAILED` with the cause, every time. At most the per-account limit per window per account, because further attempts are refused before the password check |
| Unknown email | `LOGIN_FAILED` (cause "unknown account", `aggregated: true`) once per client address per window |
| Account locked | `LOGIN_BLOCKED` once per account per window |
| Address locked | `LOGIN_BLOCKED` (entity `ip:<address>`) once per address per window |
| Global limit hit | `LOGIN_BLOCKED` (entity `global`) at most once per 15 minutes |

No entry holds a password, hash or session token.

Every sign-in whose password was actually checked is also kept, unaggregated, in `login_attempts`
(email, address, outcome `SUCCESS`/`BAD_PASSWORD`/`UNKNOWN_ACCOUNT`/`INACTIVE`, user agent, time)
for `LOGIN_ATTEMPT_RETENTION_DAYS`. Refused requests (429/503) are only counted, not stored one by
one: that is what keeps the table bounded under a flood. To investigate, for example:

```sql
-- Failed sign-ins per address in the last day
SELECT "ipAddress", outcome, count(*) FROM login_attempts
WHERE "createdAt" > now() - interval '1 day' AND NOT success GROUP BY 1, 2 ORDER BY 3 DESC;

-- Everything for one email
SELECT "createdAt", "ipAddress", outcome, "userAgent" FROM login_attempts
WHERE email = 'someone@company.com' ORDER BY "createdAt" DESC LIMIT 100;

-- Who is locked right now (counters; accounts appear as hashes)
SELECT key, "windowStart", count FROM auth_rate_limits WHERE "expiresAt" > now() ORDER BY count DESC LIMIT 20;
```

## 6. Monitoring and failure modes

- **503 on sign-in** with "Sign-in is busy": the password pool is full (a flood, or too few
  threads for the real load) or the database is unreachable. Check `/api/health` and the database
  first; if only sign-in is affected, consider raising `AUTH_HASH_THREADS` (keep one core free).
- **429**: a limit was reached. `LOGIN_BLOCKED` entries in the audit log say which (account,
  address or global).
- The server log shows `[auth] sign-in limits unavailable` when the counters cannot be reached
  (error type only), and `[auth] rate-limit cleanup failed` if housekeeping fails (it is retried a
  minute later).
- Measurements for this design (4-core machine, production build) are in the PR description of
  "PR-A: Authentication, Login DoS Protection & HTTP Request Security".

## 7. Deployment and rollback

The migration `20261121090000_auth_rate_limits` is additive: it adds the table `auth_rate_limits`,
two nullable columns to `login_attempts` (`outcome`, `userAgent`) and two indexes. Apply it with
`npm run db:migrate` before starting the new version. The previous version of the app runs on the
migrated database unchanged (it ignores the new table and columns), so rolling the code back does
not require rolling the database back. To remove the schema change entirely after rolling back:

```sql
DROP TABLE IF EXISTS auth_rate_limits;
DROP INDEX IF EXISTS "login_attempts_createdAt_idx";
ALTER TABLE login_attempts DROP COLUMN IF EXISTS outcome, DROP COLUMN IF EXISTS "userAgent";
DELETE FROM _prisma_migrations WHERE migration_name = '20261121090000_auth_rate_limits';
```

After an upgrade, existing lockouts start fresh (the old version counted rows in `login_attempts`;
the new one uses the counters).

The migration `20261121120000_login_devices` (known devices, §2) is additive too: one new table
`login_devices`, nothing else changes. The previous version ignores it. To remove it after rolling
the code back:

```sql
DROP TABLE IF EXISTS login_devices;
DELETE FROM _prisma_migrations WHERE migration_name = '20261121120000_login_devices';
```
