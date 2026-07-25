# Security

This is a Phase-1 prototype. It has real, tested security controls in some
places (see below) and known, deliberately-scoped gaps in others. This
document exists so nothing here is silently assumed to be more hardened
than it actually is — read it before using this with real customer data.

## What's actually enforced

- **Auth**: email/password via Better Auth, with TOTP MFA available
  (`twoFactor` plugin) and backup codes shown once at enrollment. No email
  verification is currently required at signup — anyone can register with
  an unowned email address.
- **RBAC**: organization-scoped `owner`/`admin`/`member` roles (Better
  Auth's `organization` plugin), enforced server-side on every route via
  `requireRole` — never trusted from the client.
- **Audit log append-only guarantee is real, not just documented**: writes
  go through a dedicated `dbgenie_audit_writer` Postgres role with
  `INSERT`/`SELECT` granted and `UPDATE`/`DELETE` explicitly revoked —
  verified live (attempting `UPDATE`/`DELETE` as that role returns
  `permission denied for table audit_logs`, not just an application-level
  restriction that a bug could bypass).
- **SQL Optimizer never executes anything**: `EXPLAIN` without `ANALYZE`
  only plans a query, it doesn't run it — true even for INSERT/UPDATE/DELETE.
  The AI's own output is text/DDL suggestions only, never executed by the
  server.
- **Rate limiting** on all `/api` routes, tighter on `/api/auth/*` and
  `/api/orgs/:orgId/chat`. Uses `express-rate-limit`'s default in-memory
  store — this resets per process and isn't shared across instances, so it
  won't hold if this is ever horizontally scaled to multiple API
  instances. A shared store (Redis-backed) would be needed at that point.

## Known limitations (prototype-scoped, not fixed yet)

- **Monitored-database credentials are encrypted with `pgcrypto` in the
  same Neon database as app data**, not a dedicated secrets manager. This
  was flagged from Stage 2 onward and is the single biggest thing to
  replace (Vault, AWS Secrets Manager, etc.) before handling real customer
  production database credentials at scale.
- **Cross-origin session cookies between the API and frontend are
  unverified against a live deployment.** The API and frontend are
  separate Render services (separate origins). `SameSite`/`Secure` cookie
  behavior and Better Auth's `trustedOrigins` need to actually be confirmed
  working across two `*.onrender.com` subdomains in production, not just
  assumed from local dev where the Vite proxy makes this a non-issue.
- **The Neon API key used for backup validation is account-wide, not
  scoped to a single project** — Neon API keys aren't project-scoped as of
  this build, so a compromised key can manage any project in the account,
  not just the ones DBGenie monitors.
- **No dead-letter handling for failed BullMQ jobs** beyond BullMQ's
  default retry behavior and structured error logs — a job that keeps
  failing doesn't page anyone or surface anywhere in the UI yet.
- **Backup validation's row-count comparison uses `pg_stat_user_tables`
  approximate counts** (fast, no full table scans) with a tolerance band
  for concurrent writes, not an exact `COUNT(*)` — it's a smoke test that
  the branch has roughly the right data, not a byte-for-byte integrity
  check.
- **`react-router` has an open advisory** ("RSC Mode CSRF Bypass",
  `GHSA-qwww-vcr4-c8h2`) with no patched version published yet as of this
  build (7.18.1 is latest and still listed as vulnerable). This app uses
  plain client-side routing (`BrowserRouter`, no RSC/server actions/data
  mode), so the specific attack surface doesn't apply here — noted for
  tracking, not treated as urgent, and should be re-checked once a fix
  ships.
- **`CORS_ORIGINS` (Express) and `trustedOrigins` (Better Auth) are two
  separate config points that must be kept in sync by hand** — there's no
  single source of truth enforcing they match.

## If you fork or deploy this

- Rotate every credential in `.env` before using this outside local
  development — this repo's own `.env` was populated with real API keys
  during development and must never be committed (`.gitignore` excludes it,
  but double-check before any `git add`).
- Generate fresh values for `BETTER_AUTH_SECRET`, `SECRETS_ENCRYPTION_KEY`,
  and `AUDIT_DB_ROLE_PASSWORD` per environment — never reuse the same
  secret across dev/staging/prod.
