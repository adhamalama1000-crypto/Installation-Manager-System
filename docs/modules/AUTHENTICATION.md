# Authentication

## 1. Module purpose

Let employees sign in securely with their email and password, keep them signed in with a safe
session cookie, let Admins invite people and reset passwords with one-time links, and protect the
system against password guessing. The module existed before the upgrade and was kept; the upgrade
fixed the password visibility toggle and shared it with every password field.

## 2. How users operate it

- **Sign in (`/login`)**: email and password, *Sign in*. The eye button shows or hides the password
  (see below). After too many failed attempts, signing in is refused for a while with the same
  generic message.
- **Set a password (`/set-password?token=…`)**: from an invitation or reset link created by an Admin
  in *Users* (*Password link*); the link works once and expires.
- **Change password (Profile)**: current password, new password (the toggle is available on all three
  fields).
- **Sign out**: in the side menu.
- **Recovering the main Admin** without the interface: `npm run reset-admin-password` (see README).

**Password visibility toggle (fixed in this upgrade).** The eye button sits inside the field on the
correct side in Arabic and English (the field is left-to-right in both, so the icon never covers the
text); pressing it keeps the typed value, the focus and the caret position, never submits the form,
works with the keyboard (Tab, Enter / Space), and reports its state (`aria-pressed`, label "Show
password" / "Hide password").

## 3. Available features

bcrypt password hashes (cost 12); random session tokens stored only as SHA-256 hashes; `HttpOnly`,
`SameSite=Lax` cookie, `Secure` when the request came over HTTPS (also behind a proxy); session
lifetime `SESSION_TTL_HOURS` (default 12); sign-in rate limiting in the database (5 failures per email
or 30 per IP in 15 minutes); one generic error for wrong password, unknown email and inactive user
(with a constant-time dummy hash for unknown emails); invitation / reset links (single use, hashed);
invitation links valid 72 hours, reset links 24 hours (a new link cancels the older ones);
same-origin check on every state-changing request; language remembered per user; sign-out ends the
session on the server.

## 4. Roles and permissions

Anyone with an active account can sign in; `users.manage` (Admin) creates users, changes roles,
deactivates accounts and creates password links. The last active Admin cannot be removed.

## 5. Business rules

- Passwords: 10–128 characters with at least one letter and one digit (shared rule for set and
  change).
- Deactivating a user ends all their sessions; a deactivated user cannot sign in.
- A successful sign-in clears the failure streak of that email; old attempts are cleaned up.
- Password links are single use and expire; using one ends the user's other sessions.

## 6. Database models and relationships

`users` (email, passwordHash, role, isActive, locale…), `sessions` (id = SHA-256 of the token,
userId, expiresAt), `password_tokens` (hash, userId, purpose, expiresAt, usedAt), `login_attempts`
(email, IP, success, time).

## 7. API routes

`POST /api/auth/login`, `POST /api/auth/logout`, `POST /api/auth/set-password` (public routes with
the same-origin check), `POST /api/me/password`, `POST /api/me/locale`,
`POST /api/users/[id]/password-link`, `/api/users` (+ `/[id]`).

## 8. Services and important logic

`src/server/auth/session.ts` (create / read / end sessions, cookie options, `requireUser`,
`requirePagePermission`), `password.ts` (bcrypt), `crypto.ts` (tokens, hashing), `rate-limit.ts`,
`src/server/services/users.ts`; UI `src/components/auth/login-form.tsx`,
`src/components/ui/password-input.tsx` (the shared field with the toggle).

## 9. Validation rules

Email trimmed and lower-cased; password 10–128 characters with a letter and a digit; set-password
token present and valid.

## 10. Error handling

Wrong credentials, unknown email, inactive user and rate limit all answer with one generic
message (no account enumeration); expired or used links say so; a session that expired sends the
browser to `/login?next=…`; cross-site POSTs are refused (403); malformed JSON gives 422.

## 11. Tests

`tests/integration/auth-cookies.test.ts` (Secure flag follows the request, sign-out),
`tests/integration/admin-password.test.ts` (the recovery script), `tests/integration/api.test.ts`
(401, sign in / out, generic message, rate limit, cross-site refusal, malformed JSON, language),
`tests/integration/users-audit-reports.test.ts`, `e2e/login.spec.ts` (**password toggle in Arabic and
English keeps value, focus and form; signing in after toggling**), `e2e/permissions.spec.ts`.

## 12. Current limitations

No two-factor authentication; no "remember me" option (one session lifetime); invitation links are
shown to the Admin to send (no e-mail service is configured).

## 13. Future improvements

Two-factor sign-in for Admins and finance; e-mail delivery of password links; a session list in
the profile with "sign out everywhere".
