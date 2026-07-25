# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

DBGenie AI — a PostgreSQL-only AI database operations copilot. This repo is
being built stage-by-stage per `DBGenie_AI_Phase1_Postgres_Project_Document.md`
(Section 4, "Four-Stage Claude Code Build Plan"). **Read that document before
starting new work** — it defines what's in scope for the current stage and
what's explicitly deferred. Do not implement a later stage's scope early
(e.g. don't build metrics collection or AI agents while still on Stage 1
foundation work) without confirming with the user first.

Currently complete: **Stage 1 (Foundation)** — auth, data model, app shell,
deployment skeleton; **Stage 2 (Postgres connector, metrics, health
dashboard)** — `PostgresConnector`, 30s BullMQ metrics collection, anomaly
detection → incidents, encrypted credential storage, Databases/Health pages;
and **Stage 3 (AI Chat + Root Cause Agent)** — RAG-grounded streaming chat,
structured-JSON root-cause diagnosis triggered by every new incident. Stage
4 (SQL optimizer, backup validation, production hardening) is not yet
built.

**Stage 3 uses the Gemini API, not Claude**, despite the project doc's
stack table saying Claude — a mid-build user decision (see README's
"Deviation from the project doc"). Don't assume the doc's AI-stack section
is current; `backend/src/ai/gemini.ts` is the source of truth.

## Commands

All commands run from the repo root using npm workspaces (`shared`,
`backend`, `frontend`).

```
npm install          # installs all three workspaces
npm run dev           # runs backend API (:3001) + frontend (:5176) + worker together, hot reload
npm run build          # builds shared -> backend -> frontend, in that order
npm start              # runs the built backend API only (backend/dist/index.js)
npm run start:worker -w backend  # runs the built worker only (backend/dist/worker.js) — separate process
npm test                # backend unit tests (vitest), builds shared first
npm run lint              # oxlint across the whole repo
npm run db:generate        # regenerate backend/drizzle/*.sql after editing backend/src/db/schema.ts
```

Single test file: `npm run test -w backend -- tests/require-role.test.ts`
(vitest passes through extra args). There's no test runner in `frontend` or
`shared` yet. `tests/postgres-connector.test.ts` and
`tests/rag-retrieval.test.ts` are integration tests against real reachable
services (`DATABASE_URL`/`VOYAGE_API_KEY`) rather than Docker/testcontainers
or mocks — no Docker in this environment, and mocking Voyage wouldn't
actually verify retrieval quality. `rag-retrieval.test.ts` additionally
needs `runbook_chunks` seeded (`npm run seed:runbooks`) and paces its own
calls ~21s apart to stay under Voyage's free-tier 3-requests/minute limit,
so it alone takes over a minute — expected. `tests/root-cause-agent.test.ts`
mocks the model call entirely and needs neither key nor network.

There is no manual DB migration step — `initDb()` runs on every boot of
**both** the API and worker (see Architecture below). Running `npm run dev`
or `npm start`/`start:worker` against a fresh Neon database is sufficient by
itself. The worker additionally needs `REDIS_URL` (BullMQ requires a real
Redis server, not a mock).

## Architecture

### Monorepo shape

- `shared/` — TypeScript types only (`src/types.ts`, `src/roles.ts`), built
  to `dist/` and consumed by both other workspaces as `@dbgenie/shared`.
  Both `backend` and `frontend` import types from here rather than
  redefining them. **Must be built (`npm run build -w shared`) before the
  other workspaces can resolve it** — `npm run dev`/`build`/`test` at the
  root all do this automatically via `predev`/`prebuild`/`pretest` hooks;
  running `npm run dev -w backend` directly does not.
- `backend/` — Express 5 API, TypeScript, `tsx` for dev.
- `frontend/` — Vite + React 19 + TypeScript + Tailwind v4 (utility classes
  only, no `tailwind.config.js` — configured via the `@tailwindcss/vite`
  plugin).

### Two deploy targets, not one process

Unlike a typical single-process Express+Vite app, **the backend does not
serve the frontend's built files**. `render.yaml` deploys three app
services: the API web service, the frontend static site, and a background
worker (`backend/src/worker.ts`) that processes BullMQ jobs — plus a
managed Redis service the queue runs on. This means:
- In dev, Vite (`frontend/vite.config.ts`) proxies `/api` and `/health` to
  the backend on `:3001` — same-origin from the browser's perspective.
- In prod, the frontend calls the API cross-origin, so `frontend/src/api/client.ts`
  and `frontend/src/lib/auth-client.ts` both read `VITE_API_BASE_URL` (unset
  in dev, since the proxy handles it) to point at the deployed API's public
  URL. This is a build-time env var for the static site — changing it
  requires rebuilding/redeploying the frontend, not just the API.
- Known unresolved gap (see README): cross-origin session-cookie behavior
  between the two `*.onrender.com` subdomains hasn't been verified against a
  live deployment.

### Auth and RBAC ride on Better Auth plugins, not custom tables

`backend/src/auth.ts` configures Better Auth with two plugins whose default
behavior does the heavy lifting:
- `organization` — provides the `organization`/`member`/`invitation` tables
  and default roles `owner`/`admin`/`member`, which is exactly the RBAC
  shape the project doc asks for. No custom access-control config exists.
- `twoFactor` — TOTP MFA (enroll/verify), adds a `twoFactorEnabled` column
  to Better Auth's `user` table and its own `twoFactor` table.

Better Auth owns and migrates its own tables (`user`, `session`, `account`,
`organization`, `member`, `twoFactor`, etc.) — these are **not** modeled in
Drizzle. `backend/src/db/schema.ts` only defines the app-specific tables
(`database_instances`, `metrics`, `incidents`, `recommendations`,
`runbook_chunks`, `chat_sessions`, `chat_messages`), which store `org_id`/
`user_id` as plain `text` columns rather than formal FKs into Better Auth's
tables — those live in a schema owned by a different migration tool that
runs first (see below) but isn't guaranteed to stay in lockstep.

`backend/src/middleware/require-role.ts` (`requireRole`) checks RBAC by
querying the `member` table directly (`"userId"`/`"organizationId"`,
camelCase columns as Better Auth defines them) rather than calling
`auth.api` at request time. It takes an injectable `lookup` function
specifically so it's unit-testable without a real DB — see
`backend/tests/require-role.test.ts` for the pattern. `requireRole` reads
`orgId` only from the route's `:orgId` param, never from the request body.

### Two migration systems, two processes calling them, one advisory lock

`backend/src/db/init.ts` (`initDb()`) is called from **both**
`index.ts` (before `app.listen`) and `worker.ts` (before it starts
processing jobs) — each process bootstraps its own DB state independently
rather than assuming the other already ran. It runs, in order, under a
`pg_advisory_lock`:
1. `CREATE EXTENSION IF NOT EXISTS vector` / `pgcrypto` (pgvector for
   `runbook_chunks.embedding`, pgcrypto for the `secrets` table).
2. Better Auth's own migration runner (`getMigrations` from
   `better-auth/db/migration`) — creates/updates its auth tables.
3. Drizzle's `migrate()` against `backend/drizzle/*.sql` — creates/updates
   app tables.

The advisory lock exists because two processes booting close together (e.g.
Render starting the API and worker services at once) would otherwise race
on step 3 — two concurrent `drizzle-orm` migration runs against a fresh
database threw a real duplicate-object error in testing even though each
run is individually transactional. If you add a third entry point that
touches the DB, call `initDb()` from it too rather than assuming API/worker
boot order.

Order matters because app tables loosely reference org/user ids created in
step 2. After editing `backend/src/db/schema.ts`, run `npm run db:generate`
to produce new SQL under `backend/drizzle/` (this does not touch the
database — the next boot applies it via step 3).

### Connector interface, not just a class

`backend/src/connectors/types.ts` defines a `DatabaseConnector` interface
(`testConnection`/`collectMetrics`/`runHealthCheck`/`getExplainPlan`/
`listTablesAndIndexes`/`getRecentQueryActivity`/`close`) deliberately kept
engine-agnostic so Phase 2 can add `MongoConnector`/etc. without touching
calling code (worker job processor, routes). `PostgresConnector`
(`postgres-connector.ts`) is the only implementation. It's backend-only —
the frontend never imports it, only the higher-level DTOs in
`@dbgenie/shared` (`Metric`, `Incident`, ...) that the API returns after
persisting connector output. `getRecentQueryActivity()` was added in Stage
3 specifically for the Root Cause Agent — `collectMetrics()` stays
aggregate-only (it's persisted every 30s) rather than widened to carry raw
query text.

`collectMetrics()` emits specific named samples
(`active_connections`, `max_connections`, `longest_running_query_seconds`)
that `services/anomaly-detection.ts` reads by name — if you change a metric
name in the connector, update the anomaly detection lookups too, they're
not typed against each other.

`getExplainPlan()` only ever runs bare `EXPLAIN`, never `EXPLAIN ANALYZE` —
`ANALYZE` actually executes the statement, `EXPLAIN` alone does not (true
even for INSERT/UPDATE/DELETE). Don't add ANALYZE to this method.

### BullMQ job scheduling

`backend/src/queue/metrics-queue.ts` registers one repeatable job per
`database_instances` row (`jobId` derived from the instance id, so
re-adding is idempotent) on a 30s interval with `immediately: true` so the
first collection happens right at onboarding rather than up to 30s later.
Jobs are scheduled from the create route (`routes/database-instances.ts`)
and re-synced on worker boot (`worker.ts`'s `syncRepeatableJobs`) as a
safety net in case Redis's scheduler state didn't survive a restart —
re-syncing is not the primary mechanism, onboarding-time scheduling is.
Deleting an instance must call `unscheduleMetricsCollection` explicitly —
BullMQ's schedule lives in Redis, not Postgres, so it isn't cleaned up by
the `ON DELETE CASCADE` that handles the DB rows.

The job processor (`queue/metrics-worker.ts`) keeps at most one **open**
incident per database instance — if anomaly detection fires again while one
is already open, it doesn't create a second row. This is a prototype-level
de-dup rule to avoid flooding `incidents` every 30s while the same
condition persists; there's no re-open/escalate logic beyond it yet.

**BullMQ custom job IDs can't contain `:`.** `queue/root-cause-queue.ts`
learned this the hard way — `jobId: \`root-cause:${incidentId}\`` throws
`Error: Custom Id cannot contain :` for a plain one-off job (fixed to
`root-cause-${incidentId}`). Repeatable jobs are exempt (`metrics-queue.ts`'s
`"metrics:" + dbInstanceId` jobId works fine) because BullMQ transforms
repeatable job IDs into an internal `repeat:<hash>:<timestamp>` format
rather than using the literal string — the colon check only applies to
non-repeatable jobs. If you add another one-off job type, use `-` in the
id, not `:`.

**`processCollectMetricsJob`'s try/catch scope matters.** Only
`connector.collectMetrics()` is wrapped in the try/catch that marks the
instance `'unreachable'` on failure — anomaly detection, incident creation,
and `enqueueRootCauseAnalysis()` run afterward, unguarded by that same
catch. This was a real bug during Stage 3 development: enqueueing the
root-cause job originally happened *inside* the connectivity try/catch, so
an unrelated queue error (the `:` job-id bug above) got caught and
incorrectly flipped the instance to `'unreachable'` even though the
database connection itself was fine. Keep "is the monitored DB reachable"
and "did downstream bookkeeping succeed" as separate failure domains if you
touch this function.

### AI Chat + Root Cause Agent (Gemini, RAG)

`backend/src/ai/gemini.ts` exports the `@google/genai` client and
`GEMINI_MODEL` (env-overridable, defaults to the `"gemini-flash-latest"`
alias — **not** `"gemini-pro-latest"`, which returned a hard `quota
exceeded ... limit: 0` on this project's free-tier key; Pro isn't available
at all without billing enabled). `-latest` aliases are used deliberately
over dated/preview ids, which Google has deprecated within months (Gemini 3
Pro Preview → 3.1 Pro Preview). The exact request/response shapes here came
from reading the installed `@google/genai` package's own `.d.ts` files
(`node_modules/@google/genai/dist/genai.d.ts`), not from web docs — this is
a very new SDK surface (the "Interactions API") and web documentation for
it was inconsistent/contradictory across pages during development.

**Gemini 3's dynamic thinking shares the output token budget.** Both
`routes/chat.ts` and `ai/root-cause-agent.ts` set
`generation_config: { max_output_tokens: 2048, thinking_level: "low" }`.
At the smaller budget this replaced (1024, no explicit thinking_level), the
model spent nearly the whole budget thinking and the root cause agent's
JSON response got cut off mid-string (`JSON.parse` failure). Also:
`thinking_level: "minimal"` is a valid value in the SDK's generic
`ThinkingLevel` type but `gemini-flash-latest` rejects it with a 400 —
`"low"` and `"high"` are the only levels this model actually accepts.

`ai/retrieval.ts`'s `retrieveRunbookChunks()` is shared by both the chat
route and the Root Cause Agent — embeds the query text (Voyage,
`input_type: "query"`, vs. `"document"` used when seeding), orders
`runbook_chunks` by pgvector `<=>` (cosine distance), returns
`similarity = 1 - distance`. `ai/root-cause-agent.ts`'s `diagnoseIncident()`
filters retrieved chunks by `RELEVANCE_SIMILARITY_THRESHOLD` (0.3, a rough
heuristic, not empirically tuned) before counting them as "relevant" for
the doc's "fewer than 2 relevant chunks retrieved" rule — pgvector always
returns the nearest K neighbors regardless of match quality, so raw topK
count alone isn't a meaningful relevance signal. That function takes an
injectable `callModel` param (same pattern as `requireRole`'s `lookup`) so
the sparse-retrieval override is unit-tested without hitting Gemini — see
`tests/root-cause-agent.test.ts`.

The Root Cause Agent uses Gemini's `response_format` (JSON-schema-
constrained output), not tool-calling/function-calling — a more direct fit
for the doc's "requiring valid JSON output," and one less round trip than
forcing a tool call and reading its arguments back out.

`ai/chunking.ts` approximates tokens at ~4 chars/token (no tokenizer
dependency) to hit the doc's "~500 tokens per chunk with overlap" target,
packing whole paragraphs rather than cutting mid-sentence.
`scripts/seed-runbooks.ts` embeds every chunk across every runbook file in
**one** batched Voyage request, not one request per file — Voyage's
free-tier rate limit (3 requests/minute without a payment method) makes
per-file batching fail past a couple of files.

### Secrets storage is intentionally not Drizzle-typed

`backend/src/secrets/store.ts` is the only module allowed to touch the
`secrets` table. It bypasses Drizzle's query builder in favor of raw
`db.execute(sql\`...\`)` calls because the encryption itself
(`pgp_sym_encrypt`/`pgp_sym_decrypt` via pgcrypto) happens inside Postgres,
not in JS — there's no natural Drizzle column type for "value encrypted
with a function call." This is explicitly flagged in code and README as a
prototype stand-in for a real secrets manager (Vault/AWS Secrets Manager).

### Org-scoped route nesting

Stage 2's data routes live under `/api/orgs/:orgId/...`
(`routes/database-instances.ts`, `routes/incidents.ts`), mounted with
`Router({ mergeParams: true })` so the parent path's `:orgId` is visible
inside the sub-router. This is what lets `requireRole` (Stage 1) work
unmodified — it already read `:orgId` from `req.params`, so nesting routes
under that path was the natural extension rather than deriving org id from
the session server-side. `backend/src/utils/params.ts`'s `reqParam()`
normalizes Express 5's `string | string[]` route-param typing to a plain
string; use it for any new `:param` route rather than casting inline.

### Frontend org auto-provisioning

Stage 1 wired up Better Auth's `organization` plugin but never gave users a
way to get one. `frontend/src/components/EnsureOrganization.tsx` (mounted
inside `RequireAuth`, wrapping `DashboardLayout`) auto-creates a single
"workspace" org on first login if the user has none, and sets it active —
there's no multi-org UI in this prototype. Pages needing `orgId` call
`authClient.useActiveOrganization()` directly rather than through a shared
context.

### Env loading is cwd-independent by design

`backend/src/load-env.ts` and `backend/drizzle.config.ts` both resolve the
repo-root `.env` via `import.meta.url` rather than relying on `dotenv/config`'s
default `process.cwd()` lookup. This exists because npm workspace scripts
(`npm run dev -w backend`, etc.) run with `cwd` set to `backend/`, where a
bare `dotenv/config` import would silently miss the root `.env`. If you add
another backend entry point that needs env vars, import
`"./load-env.js"` first, before any module that reads `process.env`.

### Frontend routing/auth pattern

`frontend/src/App.tsx` is a single route table. Protected routes are
wrapped in `<RequireAuth>` (`frontend/src/components/RequireAuth.tsx`) at
the route level, not per-page. The dashboard shell
(`DashboardLayout`/`Sidebar`/`Topbar`) wraps only the authenticated area;
`/login`, `/signup`, and `/mfa/enroll` render outside it.
