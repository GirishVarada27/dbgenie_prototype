# DBGenie AI — Phase 1 (Stage 3: AI Chat + Root Cause Agent)

PostgreSQL-only AI database operations copilot. Stage 1 (auth, data model,
app shell), Stage 2 (Postgres connector, metrics, anomaly detection, health
dashboard), and Stage 3 (RAG-grounded AI chat, Root Cause Agent) are
complete. See `DBGenie_AI_Phase1_Postgres_Project_Document.md` for the full
phase plan.

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
- AI: Gemini API (`@google/genai`) for chat + Root Cause Agent; Voyage AI for RAG embeddings
- ORM/migrations: Drizzle ORM (app tables) + Better Auth's own migration runner (auth tables)
- Auth: Better Auth — email/password + TOTP MFA + organization-scoped RBAC (`owner`/`admin`/`member`)
- Monorepo: npm workspaces — `shared` (TS types), `backend`, `frontend`

## Prerequisites

- Node.js 20+ (built against Node 24)
- A Neon Postgres connection string (or any Postgres 15+ with `vector` and `pgcrypto` available)
- A Redis connection string (BullMQ requires a real Redis server — an in-memory mock won't work). Any provider works; use `rediss://` instead of `redis://` if it requires TLS (e.g. Upstash)
- A Gemini API key ([aistudio.google.com/apikey](https://aistudio.google.com/apikey))
- A Voyage AI API key ([dash.voyageai.com](https://dash.voyageai.com))

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
   - `GEMINI_API_KEY` — AI Chat + Root Cause Agent
   - `GEMINI_MODEL` — optional, defaults to `gemini-flash-latest` (see `ai/gemini.ts` for why not Pro)
   - `VOYAGE_API_KEY` — RAG embeddings for runbook_chunks

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
   `chat_messages`, `secrets`).

Because two processes can boot around the same time, the whole sequence
runs under a Postgres advisory lock (`pg_advisory_lock`) so their migration
runs serialize instead of racing against each other.

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

`render.yaml` defines four services (API web service, frontend static
site, background worker, and managed Redis) but nothing is deployed yet.
`DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `CORS_ORIGINS`,
`SECRETS_ENCRYPTION_KEY`, `GEMINI_API_KEY`, `VOYAGE_API_KEY`, and
`VITE_API_BASE_URL` are all marked `sync: false` and need to be set
manually in the Render dashboard after the first deploy. `REDIS_URL` is
wired automatically from the `dbgenie-redis` service via `fromService`.

**Known gap to revisit before deploying:** the API and frontend are
separate origins in this topology (different Render services), so the
Better Auth session cookie is cross-origin between them. Confirm
`SameSite`/`Secure` cookie settings and `trustedOrigins` actually work
across two `*.onrender.com` subdomains before relying on this in
production — this wasn't exercised against a live deployment.

## What's not in Stage 3

The SQL optimizer and backup validation are out of scope for this stage —
see the project document for Stage 4. The SQL Optimizer page in the
frontend is still a placeholder. Capacity forecasting and the Security
agent are deferred to Phase 2 entirely (see the project document,
Section 5). Retrieval from past resolved incidents (mentioned in the doc
alongside runbook retrieval) isn't implemented — a fresh prototype has no
resolved incidents to retrieve from yet, and the doc frames it as
conditional ("once any exist").
