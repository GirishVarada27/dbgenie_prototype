# DBGenie AI — Phase 1 (complete: Stages 1-4) + Stage 5

PostgreSQL-only AI database operations copilot. All four Phase-1 stages are
complete: auth/RBAC/app shell, Postgres connector/metrics/health dashboard,
RAG-grounded AI chat + Root Cause Agent, and SQL Optimizer + backup
validation + production hardening. See
`DBGenie_AI_Phase1_Postgres_Project_Document.md` for the full phase plan
and `SECURITY.md` for known limitations before using this with real data.

**Stage 5** (a follow-up prompt, not part of the original project doc)
added a dark "command-center" visual redesign across every page, verified
and rounded out the AI Chat streaming UX (typing indicator, one automatic
reconnect), hybrid RAG grounding (general-PostgreSQL-knowledge answers are
now allowed when retrieval is weak, but always labeled "general guidance"
rather than presented as cited), and 8 more seeded runbooks (16 total).
See CLAUDE.md's "Stage 5" section for implementation details, including an
empirical recalibration of the grounding similarity threshold.

**Deviation from the project doc:** the doc's stack table specifies Claude
for AI Chat and the Root Cause Agent. This build uses the **Gemini API**
instead (`@google/genai`), at the user's explicit request mid-build — see
`backend/src/ai/gemini.ts`. Embeddings still use Voyage AI as originally
planned (Anthropic's recommended embeddings partner) since Anthropic
doesn't offer an embeddings API and that choice is independent of which
chat model is used.

## Stack

- Frontend: Vite + React + TypeScript + Tailwind CSS + Recharts
- Backend API: Node.js + Express + TypeScript
- Background worker: Node.js + BullMQ + TypeScript (separate process/entry point)
- Database: Neon PostgreSQL (`pgvector` + `pgcrypto` extensions enabled on boot)
- Job queue: Redis (BullMQ)
- AI: Gemini API (`@google/genai`) for chat, Root Cause Agent, and the SQL Optimizer; Voyage AI for RAG embeddings
- Backup validation: Neon API (temporary branch create/compare/teardown)
- Logging: pino (structured JSON, request-id/correlation-id tagged)
- ORM/migrations: Drizzle ORM (app tables) + Better Auth's own migration runner (auth tables)
- Auth: Better Auth — email/password + TOTP MFA + organization-scoped RBAC (`owner`/`admin`/`member`)
- Monorepo: npm workspaces — `shared` (TS types), `backend`, `frontend`
- CI: GitHub Actions — lint, build, migrate, and test against real Postgres + Redis service containers

## Prerequisites

- Node.js 20+ (built against Node 24)
- A Neon Postgres connection string (or any Postgres 15+ with `vector` and `pgcrypto` available)
- A Redis connection string (BullMQ requires a real Redis server — an in-memory mock won't work). Any provider works; use `rediss://` instead of `redis://` if it requires TLS (e.g. Upstash)
- A Gemini API key ([aistudio.google.com/apikey](https://aistudio.google.com/apikey))
- A Voyage AI API key ([dash.voyageai.com](https://dash.voyageai.com))
- A Neon API key ([console.neon.tech/app/settings/api-keys](https://console.neon.tech/app/settings/api-keys)) — only needed to use backup validation

## Setup

1. Install dependencies from the repo root:

   ```
   npm install
   ```

2. Copy the env file and fill in your connection strings and API keys:

   ```
   cp .env.example .env
   ```

   Required variables (see `.env.example`):
   - `DATABASE_URL` — Neon pooled connection string
   - `PORT` — backend port (default `3001`)
   - `BETTER_AUTH_SECRET` — generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
   - `BETTER_AUTH_URL` — `http://localhost:3001` in dev
   - `CORS_ORIGINS` — comma-separated allowed origins; `http://localhost:5176` in dev
   - `REDIS_URL` — used by both the API (enqueues jobs) and the worker (processes them)
   - `SECRETS_ENCRYPTION_KEY` — generate the same way as `BETTER_AUTH_SECRET`; encrypts stored monitored-database credentials (see Secrets storage below)
   - `GEMINI_API_KEY` — AI Chat, Root Cause Agent, SQL Optimizer
   - `GEMINI_MODEL` — optional, defaults to `gemini-flash-latest` (see `ai/gemini.ts` for why not Pro)
   - `VOYAGE_API_KEY` — RAG embeddings for runbook_chunks
   - `NEON_API_KEY` — backup validation (only needed for instances that set a Neon project ID)
   - `AUDIT_DB_ROLE_PASSWORD` — generate the same way as `BETTER_AUTH_SECRET`; password for the restricted, append-only `dbgenie_audit_writer` DB role (see Audit log below)
   - `LOG_LEVEL` — optional, defaults to `info` (pino level)

   The frontend doesn't need a `.env` for local dev (Vite proxies `/api` and
   `/health` to the backend — see `frontend/vite.config.ts`). See
   `frontend/.env.example` for the production-only `VITE_API_BASE_URL`.

3. Seed the runbook corpus that grounds AI Chat and the Root Cause Agent:

   ```
   npm run seed:runbooks
   ```

   Reads every `.md` file in `runbooks/` (7 sample Postgres troubleshooting
   runbooks are included — connection saturation, long-running queries,
   lock contention, replication lag, cache hit ratio, autovacuum/bloat,
   deadlocks, rollback spikes), chunks each (~500 tokens, with overlap),
   embeds every chunk in one batched Voyage request, and replaces the
   contents of `runbook_chunks`. Re-run after editing any runbook. Point it
   at a different folder with `npm run seed:runbooks -- /path/to/runbooks`
   or `RUNBOOKS_DIR`.

4. Start everything:

   ```
   npm run dev
   ```

   This builds `shared` once, then runs the backend API
   (`http://localhost:3001`), the frontend (`http://localhost:5176`, Vite
   HMR), and the background worker together, all with auto-reload.

## Migrations

There is no manual migration step. `initDb()` (`backend/src/db/init.ts`) is
called from **both** the API and worker entry points on every boot, and:

1. Ensures the `vector` and `pgcrypto` Postgres extensions exist.
2. Runs Better Auth's own migrations (user/session/organization/two-factor tables).
3. Runs Drizzle migrations for app tables (`database_instances`, `metrics`,
   `incidents`, `recommendations`, `runbook_chunks`, `chat_sessions`,
   `chat_messages`, `secrets`, `backup_validations`, `audit_logs`).
4. Creates (or updates the password on) the restricted `dbgenie_audit_writer`
   Postgres role and grants it `INSERT`/`SELECT` on `audit_logs` only — see
   Audit log below.

Because two processes can boot around the same time, the whole sequence
runs under a Postgres advisory lock (`pg_advisory_lock`) so their migration
runs serialize instead of racing against each other.

Want to migrate without starting the app (e.g. before running tests
against a fresh database)? `npm run migrate` does just the steps above and
exits.

If you change `backend/src/db/schema.ts`, regenerate the Drizzle migration
SQL before starting the server again:

```
npm run db:generate
```

This writes new files under `backend/drizzle/` and doesn't touch the
database itself — the next boot applies them.

## Background worker & metrics collection

`backend/src/worker.ts` is a separate process (not served over HTTP) that:

- On boot, re-registers a 30-second repeatable BullMQ job for every
  `active` database instance, as a safety net in case the queue's
  repeatable-job state didn't survive a Redis restart.
- Processes `collect-metrics` jobs: connects to the monitored database via
  `PostgresConnector` (`backend/src/connectors/postgres-connector.ts`,
  reading `pg_stat_activity`, `pg_stat_database`, `pg_stat_bgwriter`,
  `pg_locks`), writes the samples to `metrics`, and runs anomaly detection
  (`backend/src/services/anomaly-detection.ts`): active connections > 80%
  of `max_connections`, or any single query running > 60s. A finding opens
  an `incidents` row (severity only) and enqueues a Root Cause Agent job,
  if one isn't already open for that instance.
- Processes `analyze-incident` jobs (`backend/src/queue/root-cause-worker.ts`):
  gathers the incident's metrics-at-detection, a live query-activity
  snapshot, and a schema summary from the monitored database
  (`backend/src/ai/root-cause-context.ts`); retrieves relevant runbook
  chunks; calls Gemini for a structured diagnosis; writes `root_cause`/
  `confidence_score`/`requires_human_review` onto the incident and one
  `recommendations` row per recommended action.

Adding a database via `POST /api/orgs/:orgId/database-instances` tests the
connection immediately (rejecting on failure) and, on success, schedules
its recurring job with `immediately: true` so the first collection runs
right away rather than waiting a full 30s.

### AI Chat + Root Cause Agent

- `POST /api/orgs/:orgId/chat` (`backend/src/routes/chat.ts`) embeds the
  message, retrieves the top 5 runbook chunks (`backend/src/ai/retrieval.ts`,
  pgvector cosine distance), streams a Gemini response over SSE
  (`event: sources` → `event: token`* → `event: done`/`event: error`), and
  persists both sides of the exchange with the cited chunks.
- The Root Cause Agent (`backend/src/ai/root-cause-agent.ts`) calls Gemini
  with `response_format` constrained to a JSON schema (not tool-calling —
  simpler and a more direct fit for "requiring valid JSON output"). Chunks
  below a similarity threshold are filtered out before counting as
  "relevant"; if fewer than 2 relevant chunks remain, `requiresHumanReview`
  is forced `true` and `confidenceScore` is capped at `0.4`, regardless of
  what the model itself reports — this override is unit-tested
  (`backend/tests/root-cause-agent.test.ts`) independent of any real
  Gemini/Voyage call.
- **Gemini gotcha worth knowing:** Gemini 3-series models have "dynamic
  thinking" on by default, and thinking tokens draw from the same
  `max_output_tokens` budget as the visible response. At a modest budget
  (1024) the model spent nearly all of it "thinking" and the JSON response
  got cut off mid-string. Fixed via `thinking_level: "low"` (the SDK's
  `ThinkingLevel` type also allows `"minimal"`, but `gemini-flash-latest`
  specifically rejects it — 400 error, not a silent no-op) plus a larger
  budget (2048). See `ai/root-cause-agent.ts` and `routes/chat.ts`.
- **Model tier note:** `gemini-pro-latest` returned "quota exceeded ...
  limit: 0" on this project's API key — the Pro tier isn't available on
  the free tier at all, unlike Flash. `GEMINI_MODEL` defaults to
  `gemini-flash-latest`; switch it once billing is enabled if Pro's
  stronger reasoning is worth it for the Root Cause Agent specifically.

### SQL Optimizer

`POST /api/orgs/:orgId/database-instances/:id/sql/analyze`
(`backend/src/routes/database-instances.ts` + `backend/src/ai/sql-optimizer.ts`)
takes a raw query, runs `EXPLAIN (FORMAT JSON)` (never `ANALYZE` — that
would actually execute the query) plus a schema/index summary, and asks
Gemini for a plain-language explanation of the plan's main cost driver, a
suggestion (a rewritten query *or* index DDL, never both unless clearly
both are needed), an estimated improvement **range** (never a single
number — nothing here is benchmarked), and a confidence score. The
frontend page shows the plan as indented text, the suggestion, and a
"Copy" button for the DDL — nothing is ever executed server-side.

### Backup validation

Database instances can optionally set a Neon project ID at onboarding
(`neonProjectId` — only meaningful if that monitored database is itself
Neon-hosted). `POST .../database-instances/:id/backup-validations`
enqueues a job (`backend/src/queue/backup-validation-worker.ts`) that:

1. Snapshots approximate row counts from the live source database.
2. Creates a temporary branch off the project's default branch via the
   Neon API (`backend/src/neon/client.ts`), waits for it to become ready.
3. Connects to the branch, runs `ANALYZE` (a brand-new branch has cold
   planner statistics even though its data is a real copy — without this,
   every table reads as ~0 rows), then compares its row counts against the
   snapshot (a tolerance band accounts for concurrent writes between steps
   1 and 2) plus a basic connectivity smoke test.
4. Always tears the branch down, pass or fail, and records the result in
   `backup_validations` (status, per-table comparison, connectivity).

The Databases page shows a "Run backup validation" button and history per
instance for any instance with a Neon project ID set.

### Rate limiting, structured logging, audit log

- **Rate limiting** (`express-rate-limit`, `backend/src/middleware/rate-limit.ts`):
  300 req/15min on all `/api` routes, 20 req/15min on `/api/auth/*` and
  `/api/orgs/:orgId/chat` specifically.
- **Structured logging** (pino, `backend/src/logger.ts` +
  `backend/src/http-logger.ts`): every HTTP request gets a request id
  (generated or echoed from an inbound `x-request-id` header, returned in
  the response). BullMQ job data carries a `correlationId` — the
  originating request id for jobs a user directly triggers (backup
  validation), or the triggering job's own id for jobs triggered by
  another job (Root Cause Agent, enqueued by the metrics-collection job
  that detected the anomaly) — so a job's log lines can always be traced
  back to what caused it.
- **Audit log** (`audit_logs` table, `backend/src/middleware/audit-log.ts`):
  records `user_id`/`org_id`/`action`/`target_entity`/before-after
  state/`ip_address`/timestamp for mutating actions (database instance
  create/delete, backup validation trigger). **Genuinely append-only, not
  just documented as such**: writes go through a separate connection pool
  (`backend/src/db/audit-pool.ts`) authenticated as a dedicated
  `dbgenie_audit_writer` Postgres role with `UPDATE`/`DELETE` explicitly
  revoked — verified live that role-based `UPDATE`/`DELETE` attempts
  return `permission denied for table audit_logs` from Postgres itself.

### Secrets storage

Monitored-database credentials are stored in a dedicated `secrets` table
(`backend/src/secrets/store.ts`), encrypted column-level with `pgcrypto`
(`pgp_sym_encrypt`/`pgp_sym_decrypt`) using `SECRETS_ENCRYPTION_KEY` — in
the same Neon database as app data. **This is a prototype-only choice**:
swap for a dedicated secrets manager (Vault/AWS Secrets Manager) before
handling real customer production databases.

## Testing, linting, building

```
npm test    # backend unit tests — vitest
npm run lint   # oxlint across the whole repo
npm run build  # builds shared, then backend, then frontend
```

`backend/tests/postgres-connector.test.ts` and
`backend/tests/rag-retrieval.test.ts` run as integration tests against
real, reachable services rather than mocks/containers (no Docker in this
environment) — they default to `DATABASE_URL`/`VOYAGE_API_KEY` and skip
cleanly if those aren't set, or if `runbook_chunks` hasn't been seeded yet
(`npm run seed:runbooks`). The RAG retrieval tests pace themselves ~21s
apart to stay under Voyage's free-tier rate limit (3 requests/minute
without a payment method on file), so that file alone takes over a minute
to run — expected, not a hang.

`backend/tests/root-cause-agent.test.ts` mocks Gemini entirely (injects a
fake model-caller function) — no API key or network call needed to run it.

**CI** (`.github/workflows/ci.yml`) runs on every push/PR to `main`: lint,
build, migrate against a real Postgres service container
(`pgvector/pgvector:pg16`, so `CREATE EXTENSION vector` works) + Redis
service container, then the full test suite. `GEMINI_API_KEY`/
`VOYAGE_API_KEY` are optional repo secrets — without them, the tests that
need real calls to those APIs skip cleanly rather than failing the build.

## Production

```
npm run build
npm start              # API only — backend/dist/index.js
npm run start:worker -w backend   # worker — backend/dist/worker.js, run as a separate process
```

`npm start` runs the API only — it does not serve the frontend, and it
does not process background jobs. In production these are three separate
processes/services (API, worker, frontend static site — see `render.yaml`),
so `VITE_API_BASE_URL` must point at the deployed API's public URL when
building the frontend for that target.

## Deployment

`render.yaml` defines three services: `dbgenie-api` (API web service),
`dbgenie-frontend` (static site), and `dbgenie-redis` (managed Redis).
There is no separate background-worker service — Render's free plan only
allows `web_service`, so `dbgenie-api` runs the BullMQ workers in-process
via `RUN_WORKER_IN_PROCESS=true` (see `backend/src/queue/start-all.ts`,
shared by both `index.ts` and the standalone `worker.ts` entrypoint used
for local dev / a paid two-process deployment). `DATABASE_URL`,
`BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `CORS_ORIGINS`,
`SECRETS_ENCRYPTION_KEY`, `GEMINI_API_KEY`, `VOYAGE_API_KEY`,
`NEON_API_KEY`, `AUDIT_DB_ROLE_PASSWORD`, and `VITE_API_BASE_URL` are all
marked `sync: false` and need to be set manually in the Render dashboard
(or via the Render API) after the first deploy. `REDIS_URL` is wired
automatically from `dbgenie-redis` when deployed as a Blueprint; deploying
the services individually (as this build's own deployment did, via direct
Render API calls) means it has to be set by hand from the Redis service's
internal connection string instead.

This build is deployed at `https://dbgenie-frontend.onrender.com`
(frontend) and `https://dbgenie-api.onrender.com` (API) on Render's free
tier. Sign-up → cross-origin session → MFA enrollment/2FA sign-in →
org/database onboarding → SQL Optimizer → backup validation → AI chat with
RAG citations → rate limiting → audit logging were all re-verified live
against these URLs after deployment, including the cross-origin
session-cookie fix described in `SECURITY.md` (Better Auth's default
`SameSite=Lax` cookie doesn't survive a cross-site frontend/API split;
fixed with `SameSite=None; Secure` when `BETTER_AUTH_URL` is HTTPS). The
incident → root-cause-agent path specifically depends on organic anomaly
detection firing against a monitored database and wasn't re-triggered on
this deployment (it was verified live during Stage 3 development against
local dev). See `SECURITY.md` for this and other known limitations.

## Phase 1 status

All four stages are complete — see the acceptance criteria in
`DBGenie_AI_Phase1_Postgres_Project_Document.md` for the full end-to-end
user journey this supports. Deferred to Phase 2 (not started, by design —
see the project document, Section 5): MongoDB/SQL Server/SAP IQ connectors,
capacity forecasting, the Security agent, and multi-tenant billing.
Retrieval from past resolved incidents (mentioned in the doc alongside
runbook retrieval) isn't implemented — a fresh prototype has no resolved
incidents to retrieve from yet, and the doc frames it as conditional
("once any exist").
