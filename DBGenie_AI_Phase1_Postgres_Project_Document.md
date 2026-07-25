# DBGenie AI — Phase 1 Project Document
## Scope: PostgreSQL-Only Production Prototype

**Version:** 1.0
**Date:** July 2026
**Supersedes for Phase 1:** Sections 3, 6, 7, 9 of the full Software Design Document (multi-engine scope)

---

## 1. Phase-1 Scope Definition

The full DBGenie AI design supports PostgreSQL, MongoDB, SQL Server, and SAP IQ. Phase 1 restricts this to **PostgreSQL only** — this is a scope cut on the *database engine dimension*, not a rewrite of the architecture. Everything designed as engine-agnostic (auth, RBAC, agent orchestration, RAG layer, UI shell) stays as-is; everything engine-specific ships for Postgres only, with the `IDatabaseConnector` interface (SDD Appendix 10) still used so Phase 2 can add engines without refactoring.

### 1.1 What's in Phase 1

| Capability | Included | Notes |
|---|---|---|
| Auth + RBAC | Yes | Full scope, unchanged from SDD Section 3 |
| Database onboarding | Yes — Postgres only | Single connector implementation |
| Metrics collection & health dashboard | Yes — Postgres only | pg_stat_* views |
| AI Chat (RAG) | Yes | pgvector-backed, works identically regardless of monitored-DB engine |
| Root Cause Agent | Yes — Postgres incidents only | |
| SQL Optimizer (Performance Agent) | Yes — Postgres EXPLAIN plans | |
| Backup validation | Recommended for Phase 1 | High trust value, moderate build cost |
| Capacity forecasting | **Deferred to Phase 2** | Needs longer metric history to be credible; low value on a fresh prototype |
| Security Agent | **Deferred to Phase 2** | Needs a populated audit log baseline first |
| MongoDB / SQL Server / SAP IQ connectors | **Deferred to Phase 2+** | Add via the existing adapter interface |

**Rationale for the cuts:** a production-ready *prototype* should prove the hardest, most differentiated parts of the product — live health monitoring, RAG-grounded AI diagnosis, and safe SQL optimization — against one engine, end to end, before paying the marginal cost of three more connectors and two agents that need weeks of accumulated data to be useful.

### 1.2 Phase-1 Success Criteria

- A user can sign up, onboard a real Postgres (Neon) database, and see live health metrics within 60 seconds.
- The Health Agent detects at least one class of real anomaly (e.g. connection pool saturation, long-running query, replication lag) and creates an Incident.
- The Root Cause Agent produces a cited, confidence-scored explanation for that incident using RAG over a seeded runbook corpus.
- The SQL Optimizer returns a concrete index/rewrite suggestion for a deliberately inefficient sample query.
- The app is deployed on Render and reachable over HTTPS with working auth.

---

## 2. Tech Stack: Your Stack vs. Best-Suited Stack

### 2.1 Your stack (used on prior projects)

| Layer | Choice |
|---|---|
| Frontend | Vite + React + Tailwind CSS |
| Backend | Node.js + Express.js |
| Database | Neon PostgreSQL |
| Auth | Better Auth |
| Hosting | Render |

### 2.2 Evaluation against this project's specific demands

DBGenie AI has three requirements that most generic CRUD apps don't: **streaming AI responses (SSE)**, **background workers polling live databases on a schedule**, and **vector search (RAG)**. Here's how your stack holds up against each:

| Requirement | Your stack | Verdict |
|---|---|---|
| Streaming AI chat (SSE) | Express supports SSE natively; Render supports long-lived connections (unlike serverless platforms) | **Good fit — no change needed** |
| Background collector workers (polling Postgres every 30s) | Render has a native "Background Worker" service type separate from the web service | **Good fit — no change needed** |
| Vector search for RAG | Neon supports the `pgvector` extension directly | **Good fit — no change needed** |
| Auth with MFA + RBAC | Better Auth supports both natively | **Good fit — no change needed** |
| Frontend needing SEO/SSR | Not a requirement — this is an authenticated dashboard app | **Vite+React (SPA) is actually preferable to Next.js here** — simpler mental model, faster dev iteration, no SSR complexity you don't need |

### 2.3 Where a "best suited" stack would differ — and whether it's worth switching

| Layer | Alternative considered | Why it's *not* clearly better for this project |
|---|---|---|
| Backend framework | NestJS (structured, DI, good for large teams) | Adds real ceremony/boilerplate for a solo-to-small-team prototype; Express + a clean folder structure gets you 90% of the benefit at a fraction of the setup cost |
| Backend framework | Fastify (faster raw throughput than Express) | True, but at prototype scale the bottleneck will be the Postgres queries and the Claude API round-trip, not Express's request overhead — this optimization doesn't matter yet |
| Frontend | Next.js | Only wins if you need SSR/SEO or file-based API routes; you don't need either for an internal dashboard product, and it would merge frontend+backend in a way that fights your existing Render two-service (web+worker) split |
| Job queue | Dedicated queue (BullMQ + Redis) instead of a simple polling worker | **This one is worth adding.** A plain setInterval-based worker doesn't survive restarts cleanly or scale past a handful of monitored databases. Recommendation below. |
| Database | Supabase instead of Neon | Roughly equivalent for this use case; Neon's branching model is actually a nice fit for a dev/staging/prod workflow, so no change recommended |

### 2.4 Net recommendation

**Keep your entire stack as-is.** It is a genuinely good match for this project's actual technical demands (SSE, scheduled workers, pgvector, MFA-capable auth), and switching frameworks would cost real time for marginal or zero benefit at prototype scale.

**One addition worth making:** introduce **BullMQ + a small Redis instance** (Render offers managed Redis) for the collector scheduling and AI-agent-invocation jobs, instead of a naive `setInterval`. This gets you retry-on-failure, job persistence across deploys, and clean scaling to more monitored databases — all real problems a raw polling loop hits within the first few weeks of real use. This is a small addition, not a stack change.

**Final Phase-1 stack:**

| Layer | Technology |
|---|---|
| Frontend | Vite + React + Tailwind CSS |
| Backend (API) | Node.js + Express.js |
| Backend (workers) | Node.js + BullMQ, deployed as a Render Background Worker |
| Job queue / cache | Redis (Render managed Redis) |
| Database | Neon PostgreSQL + `pgvector` extension |
| AI | Claude API (Sonnet), called from the API and worker services |
| Auth | Better Auth (email/password + MFA) |
| Hosting | Render (Web Service + Background Worker + Redis, all in one project) |

---

## 3. Data Model (Phase-1, Postgres-only)

Simplified from the full SDD schema — no `engine` branching needed yet, but the column is kept for forward compatibility with Phase 2.

```
organizations, users, sessions          -- Better Auth manages sessions/users tables
database_instances
  id, org_id, name, engine ('postgres'),  -- engine kept for Phase-2 forward-compat
  connection_secret_ref, ssl_mode, status, created_at
metrics
  id, db_instance_id, metric_name, value, ts
incidents
  id, db_instance_id, severity, root_cause, confidence_score,
  requires_human_review, status, created_at
recommendations
  id, incident_id, agent_source, action_text, confidence_score
runbook_chunks
  id, content, embedding (vector), source_title
chat_sessions / chat_messages
  standard fields + sources[] (jsonb) for RAG citations
```

---

## 4. Four-Stage Claude Code Build Plan

Each stage below is a **complete, standalone prompt** — paste it into Claude Code as-is at the start of that stage. Stages are sequential; do not start Stage 2 until Stage 1's acceptance criteria pass.

---

### Stage 1 — Foundation: Auth, Data Model, App Shell, Deployment Skeleton

```
You are building DBGenie AI Phase 1, a PostgreSQL-only AI database
operations copilot. This is Stage 1 of 4: Foundation.

TECH STACK (use exactly this — do not substitute):
- Frontend: Vite + React + Tailwind CSS
- Backend API: Node.js + Express.js
- Database: Neon PostgreSQL (I will provide a connection string)
- Auth: Better Auth (email/password + TOTP MFA)
- Hosting target: Render (Web Service for API, static site for frontend)

SCOPE FOR THIS STAGE:
1. Monorepo structure: /frontend (Vite+React+Tailwind), /backend (Express),
   /shared (TypeScript types shared by both).
2. Set up Neon Postgres connection using a pooled connection string via
   an environment variable DATABASE_URL. Enable the pgvector extension.
3. Implement the following tables via a migration tool (use node-pg-migrate
   or Drizzle ORM migrations — your choice, but be consistent throughout
   the project): organizations, users (via Better Auth schema),
   database_instances, metrics, incidents, recommendations, runbook_chunks
   (with a vector column), chat_sessions, chat_messages.
4. Integrate Better Auth: email/password signup+login, session cookies
   (httpOnly, Secure, SameSite=Strict), and TOTP-based MFA enrollment/verify.
5. Implement basic RBAC: roles 'owner', 'admin', 'member' scoped to an
   organization. Add Express middleware that checks role on protected routes.
6. Build the frontend app shell: login page, signup page, MFA enrollment
   flow, and an authenticated dashboard layout (sidebar nav + top bar)
   with placeholder pages for: Databases, Health, AI Chat, SQL Optimizer.
7. Add a health check endpoint GET /health returning 200 + basic DB
   connectivity check.
8. Write a README with local setup instructions (env vars needed, how to
   run migrations, how to start both services).
9. Prepare render.yaml (Render Blueprint) defining: the API web service,
   the frontend static site, and a placeholder background worker service
   (to be used starting Stage 2) — don't deploy yet, just have the config
   ready.

ACCEPTANCE CRITERIA:
- I can sign up, log in, enroll MFA, and reach an empty authenticated
  dashboard shell.
- Migrations run cleanly against a fresh Neon database.
- npm run dev starts both frontend and backend with hot reload.
- All new code has basic unit tests (auth middleware, RBAC checks).

Do not implement database onboarding, metrics collection, or any AI
features yet — that starts in Stage 2. Ask me before making any
architectural decision not specified above.
```

---

### Stage 2 — PostgreSQL Connector, Metrics Collection, Health Dashboard

```
This is Stage 2 of 4 for DBGenie AI Phase 1. Stage 1 (auth, data model,
app shell) is complete and in the repo — build on top of it, don't
restructure what exists unless something is clearly broken.

SCOPE FOR THIS STAGE:
1. Add Redis (BullMQ) as the job queue. Add a new /worker service
   (separate entry point, deployed as a Render Background Worker) that
   will run all scheduled and async jobs going forward.
2. Implement a PostgresConnector class implementing this interface:
     testConnection(): Promise<ConnectionResult>
     collectMetrics(): Promise<MetricSample[]>
     runHealthCheck(): Promise<HealthReport>
     getExplainPlan(sql: string): Promise<QueryPlan>
     listTablesAndIndexes(): Promise<SchemaSnapshot>
   Design this as an interface (not just a class) so Phase 2 can add
   MongoConnector etc. without touching calling code.
3. Build the "Add Database" flow: form to enter a target Postgres
   connection (host/port/db/user/password), test the connection, then
   store credentials — NOT in the main database. Use Neon itself as a
   simple secrets store for this prototype (a separate, more restricted
   'secrets' table with column-level encryption via pgcrypto), with a
   comment in the code marking this as the spot to swap in a real
   secrets manager (Vault/AWS Secrets Manager) before real production use.
4. Implement a BullMQ repeating job (every 30s per db_instance) that
   collects metrics via PostgresConnector.collectMetrics() — target
   pg_stat_activity, pg_stat_database, pg_stat_bgwriter, pg_locks — and
   writes rows to the metrics table.
5. Implement basic anomaly detection in the worker: if active connections
   > 80% of max_connections, or any single query has been running >60s,
   create a row in incidents with status='open' and no root_cause yet
   (that's Stage 3).
6. Build the Health Dashboard page: list of onboarded databases, each
   showing current status, key metrics as simple charts (use Recharts),
   and a list of open incidents.
7. Add basic tests for PostgresConnector against a local test Postgres
   container (use testcontainers or a docker-compose test setup).

ACCEPTANCE CRITERIA:
- I can add a real Postgres connection (e.g. a Neon branch database) and
  see it appear as 'active' after a successful connection test.
- Metrics populate in the dashboard within 60 seconds of onboarding.
- Running a deliberately long query (pg_sleep(90)) against the monitored
  DB creates a visible open incident within one collection cycle.

Do not implement the AI Chat or Root Cause Agent yet — that's Stage 3.
```

---

### Stage 3 — AI Chat (RAG) + Root Cause Agent

```
This is Stage 3 of 4 for DBGenie AI Phase 1. Stages 1-2 (auth, data
model, Postgres connector, metrics, health dashboard) are complete.

SCOPE FOR THIS STAGE:
1. Set up the Claude API integration (use the Anthropic Node SDK). Store
   the API key as an environment variable, never in code.
2. Build a runbook seeding script: takes a folder of markdown runbook
   docs (I will provide 5-10 sample Postgres troubleshooting runbooks),
   chunks them (~500 tokens per chunk with overlap), generates
   embeddings, and stores them in runbook_chunks with pgvector.
3. Implement POST /chat:
   - Embed the user's message.
   - Vector-search runbook_chunks (and past resolved incidents once any
     exist) for the top-5 most relevant chunks.
   - Call Claude with a system prompt that instructs it to answer ONLY
     from the provided context, cite which chunk(s) support each claim,
     and explicitly say when it doesn't have enough context.
   - Stream the response back to the frontend via Server-Sent Events.
   - Persist the full exchange in chat_sessions/chat_messages including
     which chunks were cited.
4. Build the Root Cause Agent as a BullMQ job triggered whenever a new
   incident is created (from Stage 2's anomaly detection):
   - Gather context: the incident's metrics at time of detection, recent
     query activity, table/index metadata for involved objects.
   - Retrieve relevant runbook_chunks via pgvector.
   - Call Claude with a system prompt requiring valid JSON output:
     { rootCause, confidenceScore (0-1), recommendedActions[],
       sourceCitations[], requiresHumanReview }
   - If fewer than 2 relevant chunks were retrieved, force
     requiresHumanReview=true and a capped confidence score.
   - Store the result in recommendations, linked to the incident.
5. Build the frontend AI Chat page (streaming message UI, citations shown
   as expandable references) and update the incident list/detail view to
   show the Root Cause Agent's output with a clear "AI-generated,
   confidence: X%" label — never presented as a certain fact.
6. Add tests: RAG retrieval returns expected chunks for known queries;
   Root Cause Agent correctly sets requiresHumanReview when retrieval is
   sparse (mock the Claude API call in tests — do not hit the real API
   in CI).

ACCEPTANCE CRITERIA:
- I can ask the AI Chat a question about a real incident and get a
  streamed, cited answer grounded in the seeded runbooks.
- Triggering the long-query incident from Stage 2 results in a Root
  Cause Agent recommendation appearing on that incident within ~30s,
  with a visible confidence score and citations.

Do not implement the SQL Optimizer or backup validation yet — Stage 4.
```

---

### Stage 4 — SQL Optimizer, Backup Validation, Production Hardening

```
This is Stage 4 of 4 for DBGenie AI Phase 1. Stages 1-3 are complete:
auth, Postgres connector, metrics/health, AI chat, and Root Cause Agent
are all working. This stage finishes the prototype to a genuinely
production-ready state.

SCOPE FOR THIS STAGE:

A. SQL Optimizer
1. Build POST /sql/analyze: accepts a db_instance_id and a raw SQL
   string. Use PostgresConnector.getExplainPlan() (read-only — run
   EXPLAIN, never EXPLAIN ANALYZE against production, since ANALYZE
   actually executes the query) plus listTablesAndIndexes() for context.
2. Call Claude with a system prompt (see pattern from Stage 3's agents)
   that returns: a plain-language explanation of the plan's main cost
   driver, either a rewritten query OR an index DDL suggestion (never
   both unless clearly needed), an estimated improvement range (never a
   single precise number), and a confidence score. The agent must never
   execute anything — text/DDL output only, for human review.
3. Build the SQL Optimizer frontend page: paste-a-query box, plan
   visualization (simple tree or indented text), and the suggestion with
   a "copy DDL" button (does not execute it).

B. Backup Validation
4. Implement a BullMQ job that, given a Neon backup/branch, spins up a
   temporary Neon branch from that backup point, runs a row-count
   comparison against expected counts (stored at backup time) and a
   basic connectivity/query smoke test, then tears the branch down.
5. Store results in a backup_validations table and surface pass/fail +
   details in the dashboard.

C. Production Hardening
6. Add rate limiting (express-rate-limit) on all API routes, tuned
   tighter on /auth/* and /chat.
7. Add structured logging (pino) across API and worker, with request IDs
   propagated through to worker jobs for traceability.
8. Add an audit_logs table and middleware that records: user_id, org_id,
   action, target_entity, before/after state (for mutating routes),
   ip_address, timestamp. Make it append-only at the DB role level (a
   dedicated Postgres role with no UPDATE/DELETE grant on this table).
9. Write a GitHub Actions CI pipeline: lint, unit tests, integration
   tests against a test Postgres container, and a build step — required
   to pass before merge to main.
10. Finalize render.yaml and deploy: web service (API), static site
    (frontend), background worker, and managed Redis, all wired together
    with the correct environment variables. Deploy to Render and confirm
    the live URL works end-to-end.
11. Write a short SECURITY.md noting current limitations honestly (e.g.
    "credentials stored with pgcrypto column encryption in Neon for this
    prototype — swap for a dedicated secrets manager before handling
    real customer production databases at scale") so nothing is silently
    overstated as more hardened than it is.

ACCEPTANCE CRITERIA:
- A full user journey works end-to-end on the deployed Render URL: sign
  up -> MFA -> onboard a real Postgres DB -> see live health -> trigger
  an incident -> get an AI root cause -> ask AI chat a follow-up ->
  paste a bad query into the SQL Optimizer -> get a suggestion -> run a
  backup validation -> see a pass/fail result.
- CI pipeline is green and required for merges.
- No secrets are present in any committed file or client-side bundle.

This completes the Phase-1 prototype. Do not start Phase-2 features
(MongoDB/SQL Server/SAP IQ connectors, Capacity or Security agents)
without a new scoping conversation.
```

---

## 5. What's Deliberately Deferred to Phase 2

- MongoDB, SQL Server, SAP IQ connectors (via the existing `IDatabaseConnector` interface — no rearchitecture needed)
- Capacity forecasting agent (needs weeks of real metric history to be trustworthy)
- Security agent (needs a populated audit-log baseline)
- Multi-tenant billing/subscription tiers
- A real secrets manager in place of the pgcrypto-encrypted column approach used for the prototype

---

*End of Phase-1 project document.*
