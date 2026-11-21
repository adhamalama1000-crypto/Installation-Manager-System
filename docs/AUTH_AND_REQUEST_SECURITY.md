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

- When the pool is full, or a check waits too long, the request gets **503** with `Retry-After: 5`
  and the message "Sign-in is busy right now". The answer is the same for every account, and the
  attempt is not counted against the account or the address.
- A worker that crashes or hangs is replaced. If workers keep failing (more than 3 in a minute) the
  replacement waits 1 s, then longer, up to 30 s, so a broken installation cannot spin the CPU.
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
| `LOGIN_MAX_FAILURES_PER_ACCOUNT` | `5` | Attempts per email per window; then the email is locked until the window ends |
| `LOGIN_MAX_FAILURES_PER_IP` | `30` | Attempts per client address per window (only with a trusted proxy, see below) |
| `LOGIN_FAILURE_WINDOW_MINUTES` | `15` | Window length for the two limits above |
| `LOGIN_MAX_FAILURES_GLOBAL_PER_MINUTE` | `300` | Attempts per minute across all accounts and addresses together |
| `LOGIN_ATTEMPT_RETENTION_DAYS` | `30` | How long raw sign-in records (`login_attempts`) are kept |

The order of checks on a sign-in:

1. The password pool must have room, otherwise **503** (no database work at all).
2. The account counter. If it is over the limit: **429** with `Retry-After`; nothing else is counted.
3. The address counter (if the address is known) and the global counter. If either is over: **429**,
   and the account slot is given back.
4. The password is checked. Success clears the account's counter and gives back the address and
   global slots. Failure keeps the counts. A check that could not run (pool busy, worker failure)
   gives back every slot.

So the counters hold failures plus attempts still in progress. A successful sign-in does not use
up anyone's allowance.

- **Unknown emails** are limited exactly like real ones, so the lockout does not reveal which
  emails exist. The counters store a SHA-256 of the email, never the email itself.
- **Fail closed:** if the counters cannot be read or written (database down), sign-in is refused
  with 503. The limits are never skipped.
- **Windows are fixed** (aligned to the clock). An attacker can use one window's allowance at its
  end and the next at its start: at most 2 × the limit in a short time, then the limit per window.
- **Growth is bounded:** every counter row has an expiry. Each instance deletes expired rows at
  most once a minute, and raw sign-in records older than the retention at most once an hour, in
  batches of 5,000, in the background. The deletes are idempotent, so instances running them at
  the same time is safe.

### Admin lockout

`npm run reset-admin-password` (scripts/admin-password.ts) reads the same counters: it shows
whether `admin@example.com` or any address is locked, and a reset clears the admin's account
counter. The raw records in `login_attempts` are kept for investigation.

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

File uploads (photos, proofs) have their own limit, `MAX_UPLOAD_MB`, and are not affected.

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
